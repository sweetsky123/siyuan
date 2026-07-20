#!/usr/bin/env node
/**
 * min-safe.js — 带分类、校验、内存三版本压缩与安全写回的前端静态资源压缩脚本
 *
 * 设计目标：
 * 1. 坚决不把错误内容写回硬盘
 * 2. 校验器与压缩器按文件类型绑定，防止分类错误导致误压
 * 3. 压缩全程只操作内存副本；通过全部校验后才原子写回
 * 4. JS 仅做「去注释 + 压缩空白」，保留 ASI 关键换行，不重命名、不改语义
 *
 * 用法：node min-safe.js [目标目录]
 * 默认目标目录为当前工作目录（建议显式传入 app/stage）
 *
 * 不动原 min.js；本文件为独立安全实现。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { glob } = require('fast-glob');
const postcss = require('postcss');
const cssnano = require('cssnano');
const htmlMinifier = require('html-minifier-terser');
const sharp = require('sharp');
const { optimize: svgoOptimize } = require('svgo');

// =============================================================================
// JS 压缩策略（terser 可选）
//
// 默认不用 terser 的原因：
// 1. terser 会做语义级压缩（常量折叠、true→!0、死代码删除、可选 mangle 等），
//    在全局脚本 / 字符串拼代码 / 依赖 ASI 的代码上存在改语义风险
// 2. 本脚本默认路径只做「去注释 + 压空白 + 保留 ASI 关键换行」，优先正确性
// 3. 需要与原 min.js 同等体积收益时，将 USE_TERSER 设为 true 即可
// =============================================================================

/**
 * 是否使用 terser 压缩 JS（含 HTML 内联 JS）
 * - true：与 min.js 相同（terser.minify + TERSER_OPTIONS；内联 JS 用 mangle.toplevel=false）
 * - false / 未设置 / 其它值：使用本脚本的 compressJsSafe（仅去注释与可删空白）
 */
const USE_TERSER = false;

/** 与 min.js 一致的 terser 选项（仅当 USE_TERSER === true 时使用） */
const TERSER_OPTIONS = {
  mangle: { toplevel: false }, // 不混淆顶层作用域，保证全局调用安全
  compress: {
    defaults: true,
    drop_console: false, // 保留 console
  },
  output: { comments: false },
};

// =============================================================================
// CI 终止开关（true = 该类问题终止 CI；false = 跳过当前文件并继续）
// 仅影响「可跳过类」问题。脚本自身状态机错误、分类器绑定错误、内存/磁盘哈希
// 不一致等属于脚本缺陷，会无条件 process.exit(1)。
// =============================================================================

/** 压缩前校验失败（如文件破损、语法/格式非法）时是否终止 CI */
const ABORT_CI_ON_PRECHECK_FAILURE = false;

/** 压缩过程抛错失败时是否终止 CI */
const ABORT_CI_ON_COMPRESS_FAILURE = true;

/** 压缩后校验失败（写回前复检不通过）时是否终止 CI */
const ABORT_CI_ON_POSTCHECK_FAILURE = true;

// =============================================================================
// 常量
// =============================================================================

/**
 * 文本类多次压缩的最大轮数
 * - 大于 0：最多压这么多轮，体积不再变小则提前停
 * - 等于 0：不限制轮数，一直压到体积不再变小为止
 * 注意：图片 / SVG 固定只压 1 轮，不受本变量影响（避免有损图被反复压没）
 */
const MAX_LOOP = 12;

/** cssnano 预设 */
const CSSNANO_PRESET = 'default';

/**
 * 是否启用 terser 路径（仅严格 true 时启用；false / undefined / 其它值均走安全压缩）
 * @returns {boolean}
 */
function isUseTerser() {
  return USE_TERSER === true;
}

/**
 * 解析文本类最大压缩轮数
 * @returns {number} 正整数，或 Number.POSITIVE_INFINITY（MAX_LOOP === 0）
 */
function resolveTextMaxRounds() {
  if (MAX_LOOP === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof MAX_LOOP === 'number' && Number.isFinite(MAX_LOOP) && MAX_LOOP > 0) {
    return Math.floor(MAX_LOOP);
  }
  // 非法值回退为 12，避免误写成负数/NaN 时死循环或 0 轮
  return 12;
}

// =============================================================================
// 工具：哈希 / 大小 / 退出
// =============================================================================

/**
 * 计算内容的十六进制摘要
 * @param {string|Buffer} data
 * @param {'sha256'|'sha384'} algo
 * @returns {string}
 */
function digestHex(data, algo) {
  return crypto.createHash(algo).update(data).digest('hex');
}

/**
 * 统一计算内容字节长度
 * @param {string|Buffer} data
 * @returns {number}
 */
function byteLengthOf(data) {
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  return Buffer.byteLength(data, 'utf8');
}

/**
 * 打印致命错误并终止 CI
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 */
function fatalExit(message, detail) {
  console.error(`\n❌ [致命] ${message}`);
  if (detail && typeof detail === 'object') {
    for (const [key, value] of Object.entries(detail)) {
      console.error(`   · ${key}: ${value}`);
    }
  }
  process.exit(1);
}

/**
 * 是否应在「可跳过类」失败时终止 CI
 * 仅当开关严格为 true 时终止；未填写或其它值均视为不终止
 * @param {boolean} flag
 * @returns {boolean}
 */
function shouldAbortCI(flag) {
  return flag === true;
}

// =============================================================================
// 单文件状态：校验标志 + 内存三版本
// =============================================================================

/**
 * 创建空的单文件处理状态
 * 所有校验标志必须显式置为 true 才算通过；undefined/null/false 均不通过
 * @returns {object}
 */
function createEmptyFileState() {
  return {
    /** 内存副本与硬盘原文件的 sha384 是否一致 */
    HashVerify: undefined,
    /** 分类器给出的校验器/压缩器是否与文件类型绑定一致 */
    FirstVerify: undefined,
    /** 压缩前只读内容校验是否通过（解释器/解析器） */
    CheckSuccess: undefined,
    /** 压缩过程是否成功得到更小结果 */
    MinSuccess: undefined,
    /** 压缩后再次核对校验器类型并校验压缩结果是否通过 */
    ReVerify: undefined,
    /** 写回前最终五项标志 + 内容复检是否全部通过 */
    FinallyCheckSuccess: undefined,
    /** 第一版：未经压缩的原始内存副本（整个单文件流程内只读） */
    memoryV1: null,
    /** 第二版：上一轮压缩结果（或首轮时的原码副本） */
    memoryV2: null,
    /** 第三版：本轮压缩输出 */
    memoryV3: null,
    /** 分类结果 */
    classified: null,
  };
}

/**
 * 清除单文件状态中的全部校验标志与内存副本，并二次确认已清空
 * 任一项未清空视为脚本缺陷，立即终止 CI
 * @param {object} state
 * @param {string} relative 相对路径，仅用于报错
 */
function clearFileState(state, relative) {
  state.HashVerify = undefined;
  state.FirstVerify = undefined;
  state.CheckSuccess = undefined;
  state.MinSuccess = undefined;
  state.ReVerify = undefined;
  state.FinallyCheckSuccess = undefined;
  state.memoryV1 = null;
  state.memoryV2 = null;
  state.memoryV3 = null;
  state.classified = null;

  const leftovers = [];
  if (state.HashVerify !== undefined) leftovers.push('HashVerify');
  if (state.FirstVerify !== undefined) leftovers.push('FirstVerify');
  if (state.CheckSuccess !== undefined) leftovers.push('CheckSuccess');
  if (state.MinSuccess !== undefined) leftovers.push('MinSuccess');
  if (state.ReVerify !== undefined) leftovers.push('ReVerify');
  if (state.FinallyCheckSuccess !== undefined) leftovers.push('FinallyCheckSuccess');
  if (state.memoryV1 !== null) leftovers.push('memoryV1');
  if (state.memoryV2 !== null) leftovers.push('memoryV2');
  if (state.memoryV3 !== null) leftovers.push('memoryV3');
  if (state.classified !== null) leftovers.push('classified');

  if (leftovers.length > 0) {
    fatalExit('清除单文件状态失败：仍有残留，脚本自身存在缺陷', {
      文件: relative || '(未知)',
      残留字段: leftovers.join(', '),
    });
  }
}

/**
 * 断言标志严格为 true；空值/false/其它值均失败
 * @param {unknown} value
 * @returns {boolean}
 */
function isStrictTrue(value) {
  return value === true;
}

// =============================================================================
// 分类器：扩展名 → 类型 / 校验器 / 压缩器（三者绑定）
// =============================================================================

/**
 * 根据路径分类文件
 * 校验器标识与压缩器标识必须一致（位图统一为 image）
 * @param {string} filePath
 * @returns {{ type: string, isText: boolean, validator: string, compressor: string, ext: string } | null}
 */
function classifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
      return { type: 'js', isText: true, validator: 'js', compressor: 'js', ext };
    case '.css':
      return { type: 'css', isText: true, validator: 'css', compressor: 'css', ext };
    case '.html':
    case '.htm':
      return { type: 'html', isText: true, validator: 'html', compressor: 'html', ext };
    case '.json':
      return { type: 'json', isText: true, validator: 'json', compressor: 'json', ext };
    case '.svg':
      return { type: 'svg', isText: false, validator: 'svg', compressor: 'svg', ext };
    case '.png':
      return { type: 'png', isText: false, validator: 'image', compressor: 'image', ext };
    case '.jpg':
    case '.jpeg':
      return { type: 'jpeg', isText: false, validator: 'image', compressor: 'image', ext };
    case '.webp':
      return { type: 'webp', isText: false, validator: 'image', compressor: 'image', ext };
    default:
      return null;
  }
}

/**
 * 核对分类绑定：校验器、压缩器必须与类型匹配
 * @param {{ type: string, validator: string, compressor: string }} classified
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyClassifierBinding(classified) {
  if (!classified || !classified.type || !classified.validator || !classified.compressor) {
    return { ok: false, reason: '分类结果缺少 type/validator/compressor 字段' };
  }

  /** 类型 → 期望的校验器与压缩器 */
  const expected = {
    js: { validator: 'js', compressor: 'js' },
    css: { validator: 'css', compressor: 'css' },
    html: { validator: 'html', compressor: 'html' },
    json: { validator: 'json', compressor: 'json' },
    svg: { validator: 'svg', compressor: 'svg' },
    png: { validator: 'image', compressor: 'image' },
    jpeg: { validator: 'image', compressor: 'image' },
    webp: { validator: 'image', compressor: 'image' },
  };

  const exp = expected[classified.type];
  if (!exp) {
    return { ok: false, reason: `未知类型: ${classified.type}` };
  }
  if (classified.validator !== exp.validator) {
    return {
      ok: false,
      reason: `校验器不匹配：类型=${classified.type} 期望校验器=${exp.validator} 实际=${classified.validator}`,
    };
  }
  if (classified.compressor !== exp.compressor) {
    return {
      ok: false,
      reason: `压缩器不匹配：类型=${classified.type} 期望压缩器=${exp.compressor} 实际=${classified.compressor}`,
    };
  }
  // 校验器与压缩器必须同名绑定（当前设计下二者一致）
  if (classified.validator !== classified.compressor) {
    return {
      ok: false,
      reason: `校验器与压缩器未绑定一致：validator=${classified.validator} compressor=${classified.compressor}`,
    };
  }
  return { ok: true };
}

// =============================================================================
// 安全 JS 压缩：仅去注释与可删空白，保留 ASI 关键换行
// =============================================================================

/**
 * 判断码点是否为空白（不含换行）
 * @param {number} code
 */
function isSpaceNoNL(code) {
  return code === 0x09 || code === 0x0b || code === 0x0c || code === 0x20 || code === 0xa0;
}

/**
 * 判断是否为换行类字符
 * @param {number} code
 */
function isLineTerm(code) {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * 标识符继续字符（含 ASCII 字母数字 _ $ 以及非 ASCII，保守处理）
 * @param {number} code
 */
function isIdContinue(code) {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x24 ||
    code >= 0x80
  );
}

/**
 * 两枚 token 之间是否必须保留至少一个空白，避免粘连改变语义
 * @param {string} prev
 * @param {string} next
 */
function needsSpaceBetween(prev, next) {
  if (!prev || !next) return false;
  const a = prev.charCodeAt(prev.length - 1);
  const b = next.charCodeAt(0);

  // 标识/关键字/数字 与 标识/关键字/数字
  if (isIdContinue(a) && isIdContinue(b)) return true;

  // 防止 ++ / -- 被粘连：`+ +` `+ ++`
  if ((a === 0x2b || a === 0x2d) && (b === 0x2b || b === 0x2d)) return true;

  // 防止 `//` 被粘成注释
  if (a === 0x2f && b === 0x2f) return true;

  return false;
}

/**
 * 前一 token 是否为限制性关键字（其后换行会触发 ASI）
 * @param {string} token
 */
function isRestrictedKeyword(token) {
  return (
    token === 'return' ||
    token === 'throw' ||
    token === 'break' ||
    token === 'continue' ||
    token === 'yield' ||
    token === 'debugger'
  );
}

/**
 * 前一 token 是否可能结束一条语句（用于判断是否保留换行以维持 ASI）
 * @param {string} token
 */
function canEndStatement(token) {
  if (!token) return false;
  if (isRestrictedKeyword(token)) return true;
  const last = token.charCodeAt(token.length - 1);
  if (isIdContinue(last)) return true;
  if (last === 0x22 || last === 0x27 || last === 0x60) return true; // " ' `
  if (last === 0x29 || last === 0x5d || last === 0x7d) return true; // ) ] }
  if (token === '++' || token === '--') return true;
  // 粗略：以 / 开头的正则
  if (token.charCodeAt(0) === 0x2f && token.length > 1) return true;
  return false;
}

/**
 * 后一 token 是否可能开启一条语句
 * @param {string} token
 */
function canStartStatement(token) {
  if (!token) return false;
  const c = token.charCodeAt(0);
  if (isIdContinue(c)) return true;
  if (c === 0x22 || c === 0x27 || c === 0x60) return true;
  if (c === 0x7b || c === 0x5b || c === 0x28) return true;
  if (c === 0x2f) return true;
  if (c === 0x2b || c === 0x2d || c === 0x7e || c === 0x21) return true;
  return false;
}

/**
 * 判断 `/` 在当前位置更可能是正则还是除法
 * @param {string} prevToken
 */
function isRegexContext(prevToken) {
  if (!prevToken) return true;
  if (
    prevToken === '(' ||
    prevToken === ',' ||
    prevToken === '=' ||
    prevToken === ':' ||
    prevToken === '[' ||
    prevToken === '!' ||
    prevToken === '?' ||
    prevToken === '{' ||
    prevToken === '}' ||
    prevToken === ';' ||
    prevToken === '&&' ||
    prevToken === '||' ||
    prevToken === '??' ||
    prevToken === '=>' ||
    prevToken === 'return' ||
    prevToken === 'case' ||
    prevToken === 'throw' ||
    prevToken === 'in' ||
    prevToken === 'of' ||
    prevToken === 'typeof' ||
    prevToken === 'delete' ||
    prevToken === 'void' ||
    prevToken === 'new' ||
    prevToken === 'await' ||
    prevToken === 'yield' ||
    prevToken === '...' ||
    prevToken === '~' ||
    prevToken === 'do' ||
    prevToken === 'else'
  ) {
    return true;
  }
  if (/^(?:[+\-*%&^|]=|===?|!==?|<<=?|>>?>?=|\*\*=?)$/.test(prevToken)) {
    return true;
  }
  if (/^[+\-*%<>&^|=]$/.test(prevToken)) {
    return true;
  }
  return false;
}

/**
 * 扫描模板字符串（支持 ${} 插值，插值内再嵌套模板）
 * @param {string} code
 * @param {number} start 指向起始反引号
 * @returns {number} 结束位置（开区间）
 */
function scanTemplate(code, start) {
  const n = code.length;
  let i = start + 1;
  while (i < n) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return i + 1;
    }
    if (ch === '$' && i + 1 < n && code[i + 1] === '{') {
      i = scanTemplateExpression(code, i + 2);
      continue;
    }
    i += 1;
  }
  throw new Error(`JS 模板字符串未闭合，偏移 ${start}`);
}

/**
 * 扫描模板插值 ${ ... }，正确处理嵌套的字符串/模板/大括号
 * @param {string} code
 * @param {number} start 指向 `{` 之后
 * @returns {number} 指向闭合 `}` 之后
 */
function scanTemplateExpression(code, start) {
  const n = code.length;
  let i = start;
  let braceDepth = 1;
  while (i < n) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i += 1;
          break;
        }
        if (isLineTerm(code.charCodeAt(i))) {
          throw new Error(`JS 插值内字符串未闭合，偏移 ${start}`);
        }
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(code, i);
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth -= 1;
      i += 1;
      if (braceDepth === 0) return i;
      continue;
    }
    if (ch === '/' && i + 1 < n) {
      if (code[i + 1] === '/') {
        i += 2;
        while (i < n && !isLineTerm(code.charCodeAt(i))) i += 1;
        continue;
      }
      if (code[i + 1] === '*') {
        i += 2;
        while (i < n - 1 && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  throw new Error(`JS 模板插值未闭合，偏移 ${start}`);
}

/**
 * 从位置 i 读取一个 JS token 或注释
 * @param {string} code
 * @param {number} i
 * @param {string} prevToken
 * @returns {{ value: string, nextIndex: number, isComment?: boolean, hadLineTerm?: boolean }}
 */
function readJsToken(code, i, prevToken) {
  const n = code.length;
  if (i >= n) {
    return { value: '', nextIndex: i };
  }
  const ch = code[i];
  const c = code.charCodeAt(i);

  // 单行注释
  if (ch === '/' && i + 1 < n && code[i + 1] === '/') {
    let j = i + 2;
    while (j < n && !isLineTerm(code.charCodeAt(j))) j += 1;
    return { value: '', nextIndex: j, isComment: true };
  }

  // 多行注释
  if (ch === '/' && i + 1 < n && code[i + 1] === '*') {
    let j = i + 2;
    let hadLineTerm = false;
    while (j < n - 1) {
      if (isLineTerm(code.charCodeAt(j))) hadLineTerm = true;
      if (code[j] === '*' && code[j + 1] === '/') {
        j += 2;
        return { value: '', nextIndex: j, isComment: true, hadLineTerm };
      }
      j += 1;
    }
    throw new Error(`JS 多行注释未闭合，偏移 ${i}`);
  }

  // 普通字符串
  if (ch === "'" || ch === '"') {
    const quote = ch;
    let j = i + 1;
    while (j < n) {
      if (code[j] === '\\') {
        j += 2;
        continue;
      }
      if (code[j] === quote) {
        j += 1;
        return { value: code.slice(i, j), nextIndex: j };
      }
      if (isLineTerm(code.charCodeAt(j))) {
        throw new Error(`JS 字符串未闭合，偏移 ${i}`);
      }
      j += 1;
    }
    throw new Error(`JS 字符串未闭合，偏移 ${i}`);
  }

  // 模板字符串
  if (ch === '`') {
    const end = scanTemplate(code, i);
    return { value: code.slice(i, end), nextIndex: end };
  }

  // 正则 或 除法
  if (ch === '/') {
    if (isRegexContext(prevToken)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (isLineTerm(code.charCodeAt(j))) {
          throw new Error(`JS 正则未闭合，偏移 ${i}`);
        }
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === '[') {
          inClass = true;
          j += 1;
          continue;
        }
        if (code[j] === ']' && inClass) {
          inClass = false;
          j += 1;
          continue;
        }
        if (code[j] === '/' && !inClass) {
          j += 1;
          while (j < n && /[a-z]/i.test(code[j])) j += 1;
          return { value: code.slice(i, j), nextIndex: j };
        }
        j += 1;
      }
      throw new Error(`JS 正则未闭合，偏移 ${i}`);
    }
    if (i + 1 < n && code[i + 1] === '=') {
      return { value: '/=', nextIndex: i + 2 };
    }
    return { value: '/', nextIndex: i + 1 };
  }

  // 数字
  if (
    (c >= 0x30 && c <= 0x39) ||
    (c === 0x2e && i + 1 < n && code.charCodeAt(i + 1) >= 0x30 && code.charCodeAt(i + 1) <= 0x39)
  ) {
    let j = i;
    while (j < n) {
      const chj = code[j];
      const cj = code.charCodeAt(j);
      if (cj >= 0x30 && cj <= 0x39) {
        j += 1;
        continue;
      }
      if (chj === '.' || chj === '_' || chj === 'n') {
        j += 1;
        continue;
      }
      if (chj === 'e' || chj === 'E') {
        j += 1;
        if (j < n && (code[j] === '+' || code[j] === '-')) j += 1;
        continue;
      }
      if (j === i + 1 && (chj === 'x' || chj === 'X' || chj === 'b' || chj === 'B' || chj === 'o' || chj === 'O')) {
        j += 1;
        continue;
      }
      if (/[a-fA-F]/.test(chj)) {
        const head = code.slice(i, j).toLowerCase();
        if (head.includes('x')) {
          j += 1;
          continue;
        }
      }
      break;
    }
    if (code.slice(i, j) === '.') {
      return { value: '.', nextIndex: i + 1 };
    }
    return { value: code.slice(i, j), nextIndex: j };
  }

  // 标识符 / 关键字
  if (isIdContinue(c) && !(c >= 0x30 && c <= 0x39)) {
    let j = i;
    while (j < n && isIdContinue(code.charCodeAt(j))) j += 1;
    return { value: code.slice(i, j), nextIndex: j };
  }

  // 三/四字符运算符
  if (code.slice(i, i + 4) === '>>>=') {
    return { value: '>>>=', nextIndex: i + 4 };
  }
  const three = code.slice(i, i + 3);
  if (
    three === '===' ||
    three === '!==' ||
    three === '>>>' ||
    three === '**=' ||
    three === '<<=' ||
    three === '>>=' ||
    three === '&&=' ||
    three === '||=' ||
    three === '??=' ||
    three === '...'
  ) {
    return { value: three, nextIndex: i + 3 };
  }

  // 双字符运算符
  const two = code.slice(i, i + 2);
  const twoOps = [
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--',
    '<<', '>>', '**', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '?.',
  ];
  if (twoOps.includes(two)) {
    return { value: two, nextIndex: i + 2 };
  }

  // 单字符
  return { value: ch, nextIndex: i + 1 };
}

/**
 * 安全 JS 压缩：基于分词，只删注释与可合并空白，保留 ASI 关键换行
 * - 字符串 / 模板 / 正则：字节级原样保留
 * - 标识符永不重命名
 * - 不增删分号
 * - 限制性产生式与「可能结束语句 + 可能开始语句」之间的换行予以保留
 * @param {string} code
 * @returns {string}
 */
function compressJsSafe(code) {
  if (typeof code !== 'string') {
    throw new Error('compressJsSafe 仅接受字符串');
  }

  const result = [];
  let prevToken = '';
  let i = 0;
  const n = code.length;

  /**
   * @param {string} token
   * @param {boolean} hadLineTerm
   */
  function pushToken(token, hadLineTerm) {
    if (!token) return;
    if (prevToken) {
      if (
        hadLineTerm &&
        (isRestrictedKeyword(prevToken) || (canEndStatement(prevToken) && canStartStatement(token)))
      ) {
        result.push('\n');
      } else if (needsSpaceBetween(prevToken, token)) {
        result.push(' ');
      }
    }
    result.push(token);
    prevToken = token;
  }

  while (i < n) {
    // 聚合空白与注释，统计是否出现换行
    let hadLineTerm = false;
    let progressed = true;
    while (progressed && i < n) {
      progressed = false;
      const c = code.charCodeAt(i);
      if (isSpaceNoNL(c) || isLineTerm(c)) {
        while (i < n) {
          const cc = code.charCodeAt(i);
          if (isLineTerm(cc)) {
            hadLineTerm = true;
            if (cc === 0x0d && i + 1 < n && code.charCodeAt(i + 1) === 0x0a) i += 2;
            else i += 1;
          } else if (isSpaceNoNL(cc)) {
            i += 1;
          } else {
            break;
          }
        }
        progressed = true;
        continue;
      }
      // 注释视为空白
      if (code[i] === '/' && i + 1 < n && (code[i + 1] === '/' || code[i + 1] === '*')) {
        const tok = readJsToken(code, i, prevToken);
        if (tok.isComment) {
          if (tok.hadLineTerm) hadLineTerm = true;
          i = tok.nextIndex;
          progressed = true;
          continue;
        }
      }
    }

    if (i >= n) break;

    const tok = readJsToken(code, i, prevToken);
    if (tok.isComment) {
      if (tok.hadLineTerm) hadLineTerm = true;
      i = tok.nextIndex;
      continue;
    }
    if (!tok.value) {
      pushToken(code[i], hadLineTerm);
      i += 1;
      continue;
    }
    pushToken(tok.value, hadLineTerm);
    i = tok.nextIndex;
  }

  return result.join('');
}

/**
 * 供 html-minifier 调用的内联 JS 安全压缩包装
 * @param {string} code
 * @param {Function} [callback]
 * @returns {string|void}
 */
function compressInlineJsSafe(code, callback) {
  try {
    const out = compressJsSafe(code);
    if (typeof callback === 'function') {
      callback(null, out);
      return;
    }
    return out;
  } catch {
    if (typeof callback === 'function') {
      callback(null, code);
      return;
    }
    return code;
  }
}

/**
 * 按 USE_TERSER 选择 JS 压缩实现（.js 文件）
 * @param {string} code
 * @returns {Promise<string>}
 */
async function compressJsByPolicy(code) {
  if (isUseTerser()) {
    // 与 min.js 相同：懒加载 terser，避免默认安全路径强依赖该包
    const terser = require('terser');
    const result = await terser.minify(code, TERSER_OPTIONS);
    return (result && result.code) || code;
  }
  return compressJsSafe(code);
}

/**
 * 组装 HTML 压缩选项；内联 JS 策略与 .js 文件一致
 * @returns {object}
 */
function buildHtmlMinifierOptions() {
  return {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    // true：与 min.js 相同；false：安全压缩包装
    minifyJS: isUseTerser() ? { mangle: { toplevel: false } } : compressInlineJsSafe,
    minifyCSS: true,
  };
}

// =============================================================================
// 校验器（与类型绑定）
// =============================================================================

/**
 * 使用 Node 语法检查 JS（临时文件 + node --check）
 * @param {string} code
 * @param {string} ext
 */
function validateJs(code, ext) {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'min-safe-js-'));
  const tmpFile = path.join(tmpDir, `check${ext || '.js'}`);
  try {
    fsSync.writeFileSync(tmpFile, code, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmpFile], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim() || `node --check 退出码 ${r.status}`;
      throw new Error(msg);
    }
  } finally {
    try {
      fsSync.unlinkSync(tmpFile);
    } catch {
      /* 忽略清理失败 */
    }
    try {
      fsSync.rmdirSync(tmpDir);
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/**
 * 校验 CSS：与压缩器同栈（postcss + cssnano）
 * 仅用空 postcss 解析过宽，部分非法输入能 parse 却在 cssnano 阶段失败
 * @param {string} code
 */
async function validateCss(code) {
  await postcss([cssnano({ preset: CSSNANO_PRESET })]).process(code, { from: undefined });
}

/**
 * 校验 HTML：以「不压缩」选项走一遍 minifier，失败则视为破损
 * @param {string} code
 */
async function validateHtml(code) {
  await htmlMinifier.minify(code, {
    collapseWhitespace: false,
    removeComments: false,
    minifyJS: false,
    minifyCSS: false,
  });
}

/**
 * 校验 JSON
 * @param {string} code
 */
function validateJson(code) {
  JSON.parse(code);
}

/**
 * 校验位图是否可被 sharp 识别
 * @param {Buffer} buf
 */
async function validateImage(buf) {
  await sharp(buf).metadata();
}

/**
 * 校验 SVG 是否可被 SVGO 解析
 * @param {Buffer|string} data
 */
function validateSvg(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
  const result = svgoOptimize(text, { multipass: false });
  if (!result || typeof result.data !== 'string') {
    throw new Error('SVGO 未能解析 SVG');
  }
}

/**
 * 按绑定类型执行内容校验
 * @param {object} classified
 * @param {string|Buffer} data
 */
async function runValidator(classified, data) {
  switch (classified.validator) {
    case 'js':
      validateJs(String(data), classified.ext);
      return;
    case 'css':
      await validateCss(String(data));
      return;
    case 'html':
      await validateHtml(String(data));
      return;
    case 'json':
      validateJson(String(data));
      return;
    case 'image':
      await validateImage(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    case 'svg':
      validateSvg(data);
      return;
    default:
      throw new Error(`未知校验器: ${classified.validator}`);
  }
}

// =============================================================================
// 压缩器（与类型绑定；仅处理内存数据）
// =============================================================================

/**
 * 单次文本/图片压缩
 * @param {object} classified
 * @param {string|Buffer} data
 * @returns {Promise<string|Buffer>}
 */
async function compressOnce(classified, data) {
  // 二次绑定检查：压缩器必须与分类一致
  const binding = verifyClassifierBinding(classified);
  if (!binding.ok) {
    throw new Error(`压缩器绑定校验失败: ${binding.reason}`);
  }

  switch (classified.compressor) {
    case 'js':
      return await compressJsByPolicy(String(data));
    case 'css': {
      const result = await postcss([cssnano({ preset: CSSNANO_PRESET })]).process(String(data), {
        from: undefined,
      });
      return result.css;
    }
    case 'html':
      return await htmlMinifier.minify(String(data), buildHtmlMinifierOptions());
    case 'json': {
      const obj = JSON.parse(String(data));
      return JSON.stringify(obj);
    }
    case 'svg': {
      // SVG 单次压缩（svgo multipass 是其内部多趟，外层仍只调用一次）
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const result = svgoOptimize(text, { multipass: true });
      return Buffer.from(result.data, 'utf8');
    }
    case 'image': {
      // 位图单次压缩：外层 compressInMemory 对 image 固定只跑 1 轮，避免有损反复压没
      const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const ext = classified.ext;
      let pipeline = sharp(input);
      if (ext === '.png') {
        pipeline = pipeline.png({ compressionLevel: 9, effort: 10, palette: false });
      } else if (ext === '.jpg' || ext === '.jpeg') {
        pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
      } else if (ext === '.webp') {
        pipeline = pipeline.webp({ quality: 95, lossless: false, effort: 6 });
      } else {
        return input;
      }
      return await pipeline.toBuffer();
    }
    default:
      throw new Error(`未知压缩器: ${classified.compressor}`);
  }
}

/**
 * 复制内存数据（字符串复制值，Buffer 拷贝字节）
 * @param {string|Buffer} data
 * @returns {string|Buffer}
 */
function cloneMemory(data) {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  return String(data);
}

/**
 * 多轮内存压缩：维护 V1(原) / V2(当前最优) / V3(本轮)
 * @param {object} state
 * @param {object} classified
 * @returns {Promise<'success'|'optimal'>} success=得到更小结果；optimal=无法更小
 */
async function compressInMemory(state, classified) {
  // 首轮：V2 ← 拷贝 V1，并核对 sha256 一致
  state.memoryV2 = cloneMemory(state.memoryV1);
  const h1 = digestHex(state.memoryV1, 'sha256');
  const h2 = digestHex(state.memoryV2, 'sha256');
  if (h1 !== h2) {
    fatalExit('压缩时：V2 与 V1 的 sha256 不一致，内存复制失败', {
      V1_sha256: h1,
      V2_sha256: h2,
      类型: classified.type,
    });
  }

  const originalSize = byteLengthOf(state.memoryV1);
  let improved = false;

  // 图片 / SVG：固定只压 1 轮（防止有损格式多轮把画质压没）
  // 文本：MAX_LOOP>0 时最多 N 轮；MAX_LOOP===0 时压到体积不再变小
  const isImageOrSvg =
    !classified.isText || classified.compressor === 'image' || classified.compressor === 'svg';
  const maxRound = isImageOrSvg ? 1 : resolveTextMaxRounds();

  for (let round = 0; round < maxRound; round++) {
    state.memoryV3 = null;
    const beforeSize = byteLengthOf(state.memoryV2);
    const compressed = await compressOnce(classified, state.memoryV2);
    state.memoryV3 = compressed;
    const afterSize = byteLengthOf(state.memoryV3);

    if (afterSize < beforeSize) {
      // 本轮更小：V2 ← V3，清空 V3，继续
      state.memoryV2 = cloneMemory(state.memoryV3);
      state.memoryV3 = null;
      improved = true;
      continue;
    }

    // 未变小：停止，丢弃 V3，保留 V2
    state.memoryV3 = null;
    break;
  }

  if (!improved || byteLengthOf(state.memoryV2) >= originalSize) {
    return 'optimal';
  }
  return 'success';
}

// =============================================================================
// 原子写回
// =============================================================================

/**
 * 原子写回硬盘：先写临时文件再 rename
 * @param {string} filePath
 * @param {string|Buffer} data
 */
async function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp_safe_${process.pid}_${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

// =============================================================================
// 单文件完整流程
// =============================================================================

/**
 * 处理「可跳过类」失败：按开关终止 CI 或跳过文件
 * @param {boolean} abortFlag
 * @param {string} phase 阶段名
 * @param {string} relative
 * @param {string} detail
 * @param {object} state
 * @returns {'skipped'}
 */
function handleSkippableFailure(abortFlag, phase, relative, detail, state) {
  if (shouldAbortCI(abortFlag)) {
    fatalExit(`${phase}失败，已按开关终止 CI`, {
      文件: relative,
      详情: detail,
      开关: 'true',
    });
  }
  console.error(`❌ [跳过] ${relative}`);
  console.error(`   · 阶段: ${phase}`);
  console.error(`   · 详情: ${detail}`);
  console.error('   · 处理: 不写回硬盘，继续下一个文件');
  clearFileState(state, relative);
  return 'skipped';
}

/**
 * 处理单个文件
 * @param {string} filePath
 * @param {string} absoluteDir
 * @param {object} state
 * @returns {Promise<'written'|'optimal'|'skipped'|'empty'>}
 */
async function processOneFile(filePath, absoluteDir, state) {
  const relative = path.relative(absoluteDir, filePath);

  // ---------- 压缩前准备：清理状态 ----------
  clearFileState(state, relative);

  // ---------- 分类 ----------
  const classified = classifyFile(filePath);
  if (!classified) {
    return 'skipped';
  }
  state.classified = classified;

  // ---------- 读入硬盘 → 内存 V1 ----------
  let diskBuffer;
  try {
    diskBuffer = await fs.readFile(filePath);
  } catch (err) {
    return handleSkippableFailure(
      ABORT_CI_ON_PRECHECK_FAILURE,
      '压缩前校验-读取文件',
      relative,
      err && err.message ? err.message : String(err),
      state,
    );
  }

  if (diskBuffer.length === 0) {
    clearFileState(state, relative);
    return 'empty';
  }

  state.memoryV1 = classified.isText ? diskBuffer.toString('utf8') : Buffer.from(diskBuffer);

  // ---------- HashVerify：内存 V1 与硬盘 sha384 ----------
  const memForHash = classified.isText ? Buffer.from(state.memoryV1, 'utf8') : state.memoryV1;
  const hashMem = digestHex(memForHash, 'sha384');
  const hashDisk = digestHex(diskBuffer, 'sha384');
  if (hashMem !== hashDisk) {
    fatalExit('HashVerify 失败：内存副本与硬盘文件的 sha384 不一致', {
      文件: relative,
      内存sha384: hashMem,
      硬盘sha384: hashDisk,
    });
  }
  state.HashVerify = true;

  // ---------- FirstVerify：分类器绑定 ----------
  const binding = verifyClassifierBinding(classified);
  if (!binding.ok) {
    state.FirstVerify = false;
    fatalExit('FirstVerify 失败：分类器绑定错误（校验器/压缩器与类型不一致）', {
      文件: relative,
      类型: classified.type,
      校验器: classified.validator,
      压缩器: classified.compressor,
      原因: binding.reason,
    });
  }
  state.FirstVerify = true;

  // ---------- CheckSuccess：压缩前只读校验 ----------
  if (!isStrictTrue(state.FirstVerify)) {
    fatalExit('压缩前校验：FirstVerify 不为 true，脚本状态机错误', {
      文件: relative,
      FirstVerify: String(state.FirstVerify),
    });
  }

  try {
    await runValidator(classified, state.memoryV1);
    state.CheckSuccess = true;
  } catch (err) {
    state.CheckSuccess = false;
    const detail = err && err.message ? err.message : String(err);
    return handleSkippableFailure(
      ABORT_CI_ON_PRECHECK_FAILURE,
      '压缩前校验-内容校验',
      relative,
      detail,
      state,
    );
  }

  // ---------- 压缩时 ----------
  if (
    !isStrictTrue(state.HashVerify) ||
    !isStrictTrue(state.FirstVerify) ||
    !isStrictTrue(state.CheckSuccess)
  ) {
    fatalExit('压缩时入口检查失败：HashVerify/FirstVerify/CheckSuccess 未全部为 true（脚本缺陷）', {
      文件: relative,
      HashVerify: String(state.HashVerify),
      FirstVerify: String(state.FirstVerify),
      CheckSuccess: String(state.CheckSuccess),
    });
  }

  let compressResult;
  try {
    compressResult = await compressInMemory(state, classified);
  } catch (err) {
    state.MinSuccess = false;
    const detail = err && err.message ? err.message : String(err);
    return handleSkippableFailure(
      ABORT_CI_ON_COMPRESS_FAILURE,
      '压缩时',
      relative,
      detail,
      state,
    );
  }

  if (compressResult === 'optimal') {
    // 已是最优：不写盘，不走压缩后流程
    clearFileState(state, relative);
    console.log(`⏭️  ${relative}  已是最优或无法进一步压缩`);
    return 'optimal';
  }

  state.MinSuccess = true;

  // ---------- 压缩后 ----------
  if (
    !isStrictTrue(state.HashVerify) ||
    !isStrictTrue(state.FirstVerify) ||
    !isStrictTrue(state.CheckSuccess) ||
    !isStrictTrue(state.MinSuccess)
  ) {
    fatalExit('压缩后入口检查失败：HashVerify/FirstVerify/CheckSuccess/MinSuccess 未全部为 true', {
      文件: relative,
      HashVerify: String(state.HashVerify),
      FirstVerify: String(state.FirstVerify),
      CheckSuccess: String(state.CheckSuccess),
      MinSuccess: String(state.MinSuccess),
    });
  }

  // ReVerify：再次核对校验器/压缩器绑定
  const rebind = verifyClassifierBinding(classified);
  if (!rebind.ok) {
    state.ReVerify = false;
    fatalExit('ReVerify 失败：压缩后分类绑定不一致', {
      文件: relative,
      原因: rebind.reason,
    });
  }

  // 压缩后再次用绑定的校验器检查压缩结果
  try {
    await runValidator(classified, state.memoryV2);
    state.ReVerify = true;
  } catch (err) {
    state.ReVerify = false;
    const detail = err && err.message ? err.message : String(err);
    return handleSkippableFailure(
      ABORT_CI_ON_POSTCHECK_FAILURE,
      '压缩后校验',
      relative,
      detail,
      state,
    );
  }

  // 最终五项标志
  if (
    !isStrictTrue(state.HashVerify) ||
    !isStrictTrue(state.FirstVerify) ||
    !isStrictTrue(state.CheckSuccess) ||
    !isStrictTrue(state.MinSuccess) ||
    !isStrictTrue(state.ReVerify)
  ) {
    fatalExit('FinallyCheck：五项校验标志未全部为 true，拒绝写回', {
      文件: relative,
      HashVerify: String(state.HashVerify),
      FirstVerify: String(state.FirstVerify),
      CheckSuccess: String(state.CheckSuccess),
      MinSuccess: String(state.MinSuccess),
      ReVerify: String(state.ReVerify),
    });
  }

  // 内容复检：(1) V1 sha256 仍等于硬盘 (2) V2 体积严格小于 V1
  const diskNow = await fs.readFile(filePath);
  const v1Buf = classified.isText ? Buffer.from(state.memoryV1, 'utf8') : state.memoryV1;
  const v1Hash = digestHex(v1Buf, 'sha256');
  const diskHash = digestHex(diskNow, 'sha256');
  if (v1Hash !== diskHash) {
    fatalExit('FinallyCheck：原始内存副本与当前硬盘文件 sha256 不一致，拒绝写回（硬盘可能已变化）', {
      文件: relative,
      内存V1_sha256: v1Hash,
      硬盘_sha256: diskHash,
    });
  }

  const sizeV1 = byteLengthOf(state.memoryV1);
  const sizeV2 = byteLengthOf(state.memoryV2);
  if (!(sizeV2 < sizeV1)) {
    fatalExit('FinallyCheck：压缩结果并未小于原文，拒绝写回', {
      文件: relative,
      原始字节: sizeV1,
      压缩后字节: sizeV2,
    });
  }

  state.FinallyCheckSuccess = true;
  if (!isStrictTrue(state.FinallyCheckSuccess)) {
    fatalExit('FinallyCheckSuccess 未能置为 true', { 文件: relative });
  }

  // 写回
  await atomicWrite(filePath, state.memoryV2);

  const saved = sizeV1 - sizeV2;
  const percent = ((saved / sizeV1) * 100).toFixed(1);
  console.log(`✅ ${relative}  ${sizeV1} → ${sizeV2} (${percent}%)`);

  clearFileState(state, relative);
  return 'written';
}

// =============================================================================
// 主流程
// =============================================================================

async function main() {
  const targetDir = process.argv[2] || '.';
  const absoluteDir = path.resolve(targetDir);
  console.log(`🔍 扫描目录: ${absoluteDir}\n`);

  const patterns = [
    '**/*.js',
    '**/*.css',
    '**/*.html',
    '**/*.htm',
    '**/*.json',
    '**/*.png',
    '**/*.{jpg,jpeg}',
    '**/*.webp',
    '**/*.svg',
  ];

  const files = await glob(patterns, {
    cwd: absoluteDir,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
    caseSensitiveMatch: false,
  });

  // 分类预扫（进入压缩流程前）
  const classifiedList = [];
  for (const f of files) {
    const c = classifyFile(f);
    if (c) {
      classifiedList.push({ filePath: f, classified: c });
    }
  }

  console.log(`📦 发现 ${files.length} 个文件，可处理 ${classifiedList.length} 个\n`);

  let totalOriginal = 0;
  let totalSaved = 0;
  let processed = 0;
  let optimalCount = 0;
  let skippedCount = 0;

  // 复用同一 state 对象，每文件入口 clear
  const state = createEmptyFileState();

  for (const item of classifiedList) {
    const relative = path.relative(absoluteDir, item.filePath);
    let sizeBefore = 0;
    try {
      const st = await fs.stat(item.filePath);
      sizeBefore = st.size;
    } catch {
      /* 读大小失败不阻断，processOneFile 会处理 */
    }

    const result = await processOneFile(item.filePath, absoluteDir, state);

    if (result === 'written') {
      processed += 1;
      try {
        const stAfter = await fs.stat(item.filePath);
        totalOriginal += sizeBefore;
        totalSaved += Math.max(0, sizeBefore - stAfter.size);
      } catch {
        totalOriginal += sizeBefore;
      }
    } else if (result === 'optimal') {
      optimalCount += 1;
    } else if (result === 'skipped') {
      skippedCount += 1;
    } else if (result === 'empty') {
      // 空文件不计数
    } else {
      fatalExit('processOneFile 返回了未知状态', {
        文件: relative,
        返回值: String(result),
      });
    }
  }

  console.log('\n=================================');
  console.log(`📊 总计压缩 ${processed} 个文件`);
  if (optimalCount > 0) {
    console.log(`⏭️  已最优/跳过压缩: ${optimalCount}`);
  }
  if (skippedCount > 0) {
    console.log(`⚠️  校验/压缩失败跳过: ${skippedCount}`);
  }
  if (totalOriginal > 0) {
    const totalPercent = ((totalSaved / totalOriginal) * 100).toFixed(1);
    console.log(`💾 节省空间: ${(totalSaved / 1024).toFixed(1)} KB (${totalPercent}%)`);
  } else {
    console.log('💤 没有文件被压缩');
  }
}

// 仅作为 CLI 直接运行时启动主流程；被 require 时可导出内部函数供测试
if (require.main === module) {
  main().catch((err) => {
    console.error('致命错误:', err);
    process.exit(1);
  });
} else {
  module.exports = {
    compressJsSafe,
    compressJsByPolicy,
    compressOnce,
    compressInMemory,
    classifyFile,
    verifyClassifierBinding,
    createEmptyFileState,
    clearFileState,
    isStrictTrue,
    shouldAbortCI,
    isUseTerser,
    resolveTextMaxRounds,
    digestHex,
    byteLengthOf,
    cloneMemory,
  };
}
