import {showMessage} from "../../dialog/message";
import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {confirmDialog} from "../../dialog/confirmDialog";
import {isInIOS, saveExportFile} from "../../protyle/util/compatibility";
import {isPaidUser, needSubscribe} from "../../util/needSubscribe";
import {getCloudURL} from "../util/about";

type SyncNamedItem = Config.ISecret | Config.IVariable;

/** 按当前配置刷新同步 Tab 可见性与动态面板（供 syncRuntime 调用） */
export const refreshSyncTabPanels = (root: Element) => {
    setSyncConfigItemVisible(root);
    setSyncModeRelatedConfigItemVisible(root);
    renderProviderConfig(root);
    renderCloudSpace(root);
};

/** 仅刷新与同步模式相关的配置项可见性（供 syncRuntime 调用） */
export const refreshSyncModeRelatedItems = (root: Element) => {
    setSyncModeRelatedConfigItemVisible(root);
};

const setSyncConfigItemVisible = (root: Element) => {
    const visible = window.siyuan.config.sync.provider === 0 ? !needSubscribe("") : isPaidUser();
    [
        "cloudSpace",
        "sync.enabled",
        "sync.generateConflictDoc",
        "sync.mode",
        "sync.interval",
        "sync.perception",
        "syncCloudDirBlock",
        "syncCloudBackupBlock",
    ]
    .forEach((id) => {
        root.querySelector(`#${CSS.escape(id)}`)?.closest(".config-item")?.classList.toggle("fn__none", !visible);
    });
};

const setSyncModeRelatedConfigItemVisible = (root: Element) => {
    const syncModeElement = root.querySelector(`#${CSS.escape("sync.mode")}`) as HTMLSelectElement | null;
    if (!syncModeElement) {
        return;
    }
    const syncMode: Config.ISync["mode"] = Number(syncModeElement.value);
    const isProviderOfficialAutoSync = syncMode === 1 && !needSubscribe("");
    root.querySelector(`#${CSS.escape("sync.interval")}`)?.closest(".config-item")?.classList.toggle("fn__none", !isProviderOfficialAutoSync);
    root.querySelector(`#${CSS.escape("sync.perception")}`)?.closest(".config-item")?.classList.toggle("fn__none", !(isProviderOfficialAutoSync && window.siyuan.config.sync.provider === 0 && window.siyuan.config.system.container !== "docker"));
};

/** 同步提供商配置区检索关键词（供 syncTab 注册 slot） */
export const getSyncProviderConfigKeywords = (): string[] => buildProviderConfigKeywords();

type SyncProviderConfigKey = Extract<keyof Config.ISync, "s3" | "webdav" | "local">;

type SyncProviderFieldDef =
    | {type: "input"; label: string; id: string; attrs?: string; tip?: string}
    | {type: "password"; label: string; id: string}
    | {type: "select"; label: string; id: string; options: {value: string; label: string}[]}
    | {type: "headers"; label: string; id: "headers"};

// 宽屏（标签与输入同行）时中英分两行；窄屏叠排时由 CSS 收成一行，如 服务端点(Endpoint)
const genBilingualLabel = (primary: string, secondary: string) => `<span class="config-provider-label"><span>${primary}</span><span>(${secondary})</span></span>`;

// 指定 TCP 连接端口说明：仅改拨号端口，适用于端口转发后端口不一致
const SYNC_CONNECT_PORT_TIP = "仅覆盖实际 TCP 连接端口，不影响 Endpoint、HTTP Host 与 S3 签名。适用于端口转发后连接端口与 Endpoint 端口不一致的场景；留空表示沿用 Endpoint 端口。";

type SyncProviderIntroDef = {
    genIntro: () => string;
    genUnpaidIntro: () => string;
    isProviderConfigAllowed: () => boolean;
};

type SyncThirdPartyProviderDef = SyncProviderIntroDef & {
    configKey: SyncProviderConfigKey;
    api: string;
    getConfig: () => Config.ISync[SyncProviderConfigKey];
    fields: SyncProviderFieldDef[];
};

type SyncProviderDef = SyncProviderIntroDef | SyncThirdPartyProviderDef;

const isThirdPartySyncProviderDef = (def: SyncProviderDef): def is SyncThirdPartyProviderDef => {
    return "configKey" in def;
};

const genThirdPartyUnpaidIntro = (): string => {
    const accountServer = getCloudURL("");
    return `<div>
    ${window.siyuan.languages._kernel[214].replaceAll("${accountServer}", accountServer)}
</div>`;
};

const SYNC_PROVIDER_DEFS: Record<Config.ISync["provider"], SyncProviderDef> = {
    0: {
        isProviderConfigAllowed: () => !needSubscribe(""),
        genIntro: () => `<div class="b3-label b3-label--inner">${window.siyuan.languages.syncOfficialProviderIntro}</div>`,
        genUnpaidIntro: () => {
            const accountServer = getCloudURL("");
            return `<div class="b3-label b3-label--inner">
    ${isInIOS() ? window.siyuan.languages._kernel[295] : window.siyuan.languages._kernel[29].replaceAll("${accountServer}", accountServer)}
</div>
<div class="b3-label b3-label--inner">
    ${window.siyuan.languages.cloudIntro1}
    <div class="b3-label__text">
        <ul class="fn__list">
            <li>${window.siyuan.languages.cloudIntro2}</li>
            <li>${window.siyuan.languages.cloudIntro3}</li>
            <li>${window.siyuan.languages.cloudIntro4}</li>
            <li>${window.siyuan.languages.cloudIntro5}</li>
            <li>${window.siyuan.languages.cloudIntro6}</li>
            <li>${window.siyuan.languages.cloudIntro7}</li>
            <li>${window.siyuan.languages.cloudIntro8}</li>
        </ul>
    </div>
</div>
<div class="b3-label b3-label--inner">
    ${window.siyuan.languages.cloudIntro9}
    <div class="b3-label__text">
        <ul style="padding-left: 2em">
            <li>${window.siyuan.languages.cloudIntro10}</li>
            <li>${window.siyuan.languages.cloudIntro11}</li>
        </ul>
    </div>
</div>`;
        },
    },
    2: {
        isProviderConfigAllowed: isPaidUser,
        configKey: "s3",
        api: "/api/sync/setSyncProviderS3",
        getConfig: () => window.siyuan.config.sync.s3,
        genIntro: () => `<div class="b3-label b3-label--inner">
    ${window.siyuan.languages.syncThirdPartyProviderS3Intro}
    <div class="fn__hr"></div>
    ${window.siyuan.languages.syncThirdPartyProviderTip}
</div>`,
        genUnpaidIntro: genThirdPartyUnpaidIntro,
        fields: [
            {type: "input", label: genBilingualLabel("服务端点", "Endpoint"), id: "endpoint"},
            {type: "input", label: genBilingualLabel("访问密钥", "Access Key"), id: "accessKey"},
            {type: "password", label: genBilingualLabel("秘密访问密钥", "Secret Key"), id: "secretKey"},
            {type: "input", label: genBilingualLabel("存储桶", "Bucket"), id: "bucket"},
            {type: "input", label: genBilingualLabel("区域 ID", "Region ID"), id: "region"},
            {type: "input", label: genBilingualLabel("超时时间(秒)", "Timeout"), id: "timeout", attrs: 'inputmode="numeric" data-number="true"'},
            {type: "select", label: genBilingualLabel("寻址方式", "Addressing"), id: "pathStyle", options: [
                {value: "true", label: "路径样式(Path-style)"},
                {value: "false", label: "虚拟托管样式(Virtual-hosted-style)"},
            ]},
            {type: "select", label: genBilingualLabel("TLS 验证", "TLS Verify"), id: "skipTlsVerify", options: [
                {value: "false", label: "启用验证(Verify)"},
                {value: "true", label: "跳过验证(Skip)"},
            ]},
            {type: "input", label: genBilingualLabel("并发请求数", "Concurrent Reqs"), id: "concurrentReqs", attrs: 'inputmode="numeric" data-number="true"'},
            {type: "input", label: genBilingualLabel("S3 签名 Host", "可选"), id: "signHost"},
            {type: "input", label: genBilingualLabel("User-Agent 请求头", "可选"), id: "userAgent"},
            {type: "input", label: genBilingualLabel("Referer 请求头", "可选"), id: "referer"},
            {type: "headers", label: genBilingualLabel("自定义请求头", "Headers"), id: "headers"},
            {type: "select", label: genBilingualLabel("DNS 解析记录类型", "可选"), id: "dnsRecordType", options: [
                {value: "", label: "-"},
                {value: "A", label: "A"},
                {value: "CNAME", label: "CNAME"},
            ]},
            {type: "input", label: genBilingualLabel("DNS 解析记录值", "IP / CNAME"), id: "dnsRecordValue"},
            {type: "input", label: genBilingualLabel("指定 TCP 连接端口", "Connect Port"), id: "connectPort", attrs: 'inputmode="numeric" data-number="true"', tip: SYNC_CONNECT_PORT_TIP},
        ],
    },
    3: {
        isProviderConfigAllowed: isPaidUser,
        configKey: "webdav",
        api: "/api/sync/setSyncProviderWebDAV",
        getConfig: () => window.siyuan.config.sync.webdav,
        genIntro: () => `<div class="b3-label b3-label--inner">
    ${window.siyuan.languages.syncThirdPartyProviderWebDAVIntro}
    <div class="fn__hr"></div>
    ${window.siyuan.languages.syncThirdPartyProviderTip}
</div>`,
        genUnpaidIntro: genThirdPartyUnpaidIntro,
        fields: [
            {type: "input", label: genBilingualLabel("服务端点", "Endpoint"), id: "endpoint"},
            {type: "input", label: genBilingualLabel("用户名", "Username"), id: "username"},
            {type: "password", label: genBilingualLabel("密码", "Password"), id: "password"},
            {type: "input", label: genBilingualLabel("超时时间(秒)", "Timeout"), id: "timeout", attrs: 'inputmode="numeric" data-number="true"'},
            {type: "select", label: genBilingualLabel("TLS 验证", "TLS Verify"), id: "skipTlsVerify", options: [
                {value: "false", label: "启用验证(Verify)"},
                {value: "true", label: "跳过验证(Skip)"},
            ]},
            {type: "input", label: genBilingualLabel("并发请求数", "Concurrent Reqs"), id: "concurrentReqs", attrs: 'inputmode="numeric" data-number="true"'},
            {type: "input", label: genBilingualLabel("User-Agent 请求头", "可选"), id: "userAgent"},
            {type: "input", label: genBilingualLabel("Referer 请求头", "可选"), id: "referer"},
            {type: "headers", label: genBilingualLabel("自定义请求头", "Headers"), id: "headers"},
            {type: "select", label: genBilingualLabel("DNS 解析记录类型", "可选"), id: "dnsRecordType", options: [
                {value: "", label: "-"},
                {value: "A", label: "A"},
                {value: "CNAME", label: "CNAME"},
            ]},
            {type: "input", label: genBilingualLabel("DNS 解析记录值", "IP / CNAME"), id: "dnsRecordValue"},
            {type: "input", label: genBilingualLabel("指定 TCP 连接端口", "Connect Port"), id: "connectPort", attrs: 'inputmode="numeric" data-number="true"', tip: SYNC_CONNECT_PORT_TIP},
        ],
    },
    4: {
        isProviderConfigAllowed: isPaidUser,
        configKey: "local",
        api: "/api/sync/setSyncProviderLocal",
        getConfig: () => window.siyuan.config.sync.local,
        genIntro: () => `<div class="b3-label b3-label--inner">
    <div class="ft__error">
        ${window.siyuan.languages.mobileNotSupport}
    </div>
    <div class="fn__hr"></div>
    ${window.siyuan.languages.syncThirdPartyProviderLocalIntro}
</div>`,
        genUnpaidIntro: () => `${genThirdPartyUnpaidIntro()}<div class="ft__error">
    <div class="fn__hr--b"></div>
    ${window.siyuan.languages.mobileNotSupport}
</div>`,
        fields: [
            {type: "input", label: genBilingualLabel("服务端点", "Endpoint"), id: "endpoint"},
            {type: "input", label: genBilingualLabel("超时时间(秒)", "Timeout"), id: "timeout", attrs: 'inputmode="numeric" data-number="true"'},
            {type: "input", label: genBilingualLabel("并发请求数", "Concurrent Reqs"), id: "concurrentReqs", attrs: 'inputmode="numeric" data-number="true"'},
        ],
    },
};

const buildProviderConfigKeywords = (): string[] => {
    const accountServer = getCloudURL("");
    return [
        // 官方云（provider === 0）
        window.siyuan.languages.syncOfficialProviderIntro,
        window.siyuan.languages._kernel[29].replaceAll("${accountServer}", accountServer),
        window.siyuan.languages._kernel[295],
        window.siyuan.languages.cloudIntro1,
        window.siyuan.languages.cloudIntro2,
        window.siyuan.languages.cloudIntro3,
        window.siyuan.languages.cloudIntro4,
        window.siyuan.languages.cloudIntro5,
        window.siyuan.languages.cloudIntro6,
        window.siyuan.languages.cloudIntro7,
        window.siyuan.languages.cloudIntro8,
        window.siyuan.languages.cloudIntro9,
        window.siyuan.languages.cloudIntro10,
        window.siyuan.languages.cloudIntro11,
        // 未订阅 / 本地等提示
        window.siyuan.languages._kernel[214].replaceAll("${accountServer}", accountServer),
        window.siyuan.languages.mobileNotSupport,
        // S3 / WebDAV / 本地第三方
        window.siyuan.languages.syncThirdPartyProviderS3Intro,
        window.siyuan.languages.syncThirdPartyProviderWebDAVIntro,
        window.siyuan.languages.syncThirdPartyProviderLocalIntro,
        window.siyuan.languages.syncThirdPartyProviderTip,
        // 操作按钮
        window.siyuan.languages.cloudStoragePurge,
        window.siyuan.languages.import,
        window.siyuan.languages.export,
        // 表单标签与选项（硬编码英文）
        "Endpoint",
        "Access Key",
        "Secret Key",
        "Bucket",
        "Region ID",
        "Timeout (s)",
        "Addressing",
        "Path-style",
        "Virtual-hosted-style",
        "TLS Verify",
        "Verify",
        "Skip",
        "Concurrent Reqs",
        "Username",
        "Password",
        "User-Agent",
        "Referer",
        "Headers",
        "DNS Record Type",
        "DNS Record Value",
        "Connect Port",
        "服务端点",
        "访问密钥",
        "秘密访问密钥",
        "存储桶",
        "区域 ID",
        "超时时间",
        "寻址方式",
        "TLS 验证",
        "并发请求数",
        "请求头",
        "自定义请求头",
        "DNS 解析记录类型",
        "DNS 解析记录值",
        "指定 TCP 连接端口",
        "用户名",
        "密码",
    ];
};

const renderProviderConfig = (root: Element) => {
    const providerConfigElement = root.querySelector("#syncProviderConfig");
    if (!providerConfigElement) {
        return;
    }

    const def = SYNC_PROVIDER_DEFS[window.siyuan.config.sync.provider];
    let html = "";
    if (def) {
        if (!def.isProviderConfigAllowed()) {
            html = def.genUnpaidIntro();
        } else if (isThirdPartySyncProviderDef(def)) {
            html = `${def.genIntro()}${def.fields.map(genProviderField).join("")}${genProviderActionButtons(def.configKey)}`;
        } else {
            html = def.genIntro();
        }
    }

    providerConfigElement.innerHTML = html;
    bindProviderConfigEvent(providerConfigElement, root);
};

const genProviderField = (field: SyncProviderFieldDef): string => {
    switch (field.type) {
        case "input":
            return genProviderFlexInput(field.label, field.id, field.attrs, field.tip);
        case "password":
            return genProviderFlexPassword(field.label, field.id);
        case "select":
            return genProviderFlexSelect(field.label, field.id, field.options.map((option) => `
    <option value="${option.value}">${option.label}</option>`).join(""));
        case "headers":
            return genProviderHeaders(field.label, field.id);
    }
};

const escapeAttr = (value: string) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// 字段说明图标：紧贴双语文案右侧，点击后以 snackbar（#message）展示
const genFieldTipIcon = (tip?: string) => {
    if (!tip) {
        return "";
    }
    return `<span class="config-provider-tip" data-field-tip="${escapeAttr(tip)}" role="button" tabindex="0" aria-label="${escapeAttr(tip)}"><svg><use xlink:href="#iconInfo"></use></svg></span>`;
};

const genPlaceholderButton = () => `<button class="block__icon block__icon--show" data-action="insertSyncPlaceholder" type="button" aria-label="Insert secret or variable">
    <svg><use xlink:href="#iconKeymap"></use></svg>
</button>`;

// 与全局设置项一致：左侧标签 fn__flex-1，右侧控件 fn__size200；仅额外挂双语与 tip
const genProviderFieldLabel = (label: string, tip = "") => `<div class="fn__flex fn__flex-1 config-provider-field-label">${label}${genFieldTipIcon(tip)}</div>`;

const genProviderFlexInput = (label: string, id: string, attrs = "", tip = "") => `<div class="b3-label b3-label--inner fn__flex config-wrap">
    ${genProviderFieldLabel(label, tip)}
    <div class="fn__space"></div>
    <div class="config-sync-placeholder fn__flex-center fn__size200">
        <input id="${id}" class="b3-text-field fn__block"${attrs ? ` ${attrs}` : ""}>
        ${genPlaceholderButton()}
    </div>
</div>`;

const genProviderFlexPassword = (label: string, id: string) => `<div class="b3-label b3-label--inner fn__flex config-wrap">
    ${genProviderFieldLabel(label)}
    <div class="fn__space"></div>
    <div class="config-sync-placeholder b3-form__icona fn__flex-center fn__size200">
        <input id="${id}" type="password" class="b3-text-field b3-form__icona-input">
        <svg class="b3-form__icona-icon" data-action="togglePassword"><use xlink:href="#iconEye"></use></svg>
        ${genPlaceholderButton()}
    </div>
</div>`;

const genProviderFlexSelect = (label: string, id: string, optionsHtml: string) => `<div class="b3-label b3-label--inner fn__flex config-wrap">
    ${genProviderFieldLabel(label)}
    <div class="fn__space"></div>
    <select class="b3-select fn__flex-center fn__size200" id="${id}">
        ${optionsHtml}
    </select>
</div>`;

// 请求头：标签仍 200px；内容区 fn__flex-1 占满剩余（多列编辑不能塞进 size200）
const genProviderHeaders = (label: string, id: "headers") => `<div class="b3-label b3-label--inner fn__flex config-wrap config-sync-headers" id="${id}">
    <div class="fn__flex-center fn__size200 config-provider-field-label">${label}</div>
    <div class="fn__space"></div>
    <div class="config-sync-headers__body fn__flex-1">
        <div class="config-sync-headers__rows" data-role="syncHeaderRows"></div>
        <button class="b3-button b3-button--outline" data-action="addSyncHeader" type="button">
            <svg><use xlink:href="#iconAdd"></use></svg>添加请求头(Add Header)
        </button>
    </div>
</div>`;
const genSyncHeaderRow = (header: Config.ISyncHeader = {name: "", value: ""}) => `<div class="config-sync-headers__row" data-role="syncHeaderRow">
    <div class="config-sync-placeholder">
        <input class="b3-text-field fn__block" data-name="name" spellcheck="false" placeholder="Name" value="${escapeAttr(header.name)}">
        ${genPlaceholderButton()}
    </div>
    <div class="config-sync-placeholder">
        <input class="b3-text-field fn__block" data-name="value" spellcheck="false" placeholder="Value" value="${escapeAttr(header.value)}">
        ${genPlaceholderButton()}
    </div>
    <button class="block__icon block__icon--show" data-action="removeSyncHeader" type="button" aria-label="Remove header">
        <svg><use xlink:href="#iconTrashcan"></use></svg>
    </button>
</div>`;

const genProviderActionButtons = (dataType: SyncProviderConfigKey) => {
    const importExportHtml = dataType === "s3" || dataType === "webdav" ? `<div class="fn__space"></div>
    <button class="b3-button b3-button--outline fn__size200" style="position: relative">
        <input id="importSyncConfig" class="b3-form__upload" type="file" data-type="${dataType}">
        <svg><use xlink:href="#iconDownload"></use></svg>${window.siyuan.languages.import}
    </button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--outline fn__size200" id="exportSyncConfig" data-type="${dataType}">
        <svg><use xlink:href="#iconUpload"></use></svg>${window.siyuan.languages.export}
    </button>` : "";
    return `<div class="b3-label b3-label--inner fn__flex fn__flex-wrap">
    <div class="fn__flex-1"></div>
    <button class="b3-button b3-button--outline fn__size200" id="purgeCloudData">
        <svg><use xlink:href="#iconTrashcan"></use></svg>${window.siyuan.languages.cloudStoragePurge}
    </button>${importExportHtml}
</div>`;
};

const syncProviderConfigBoundElements = new WeakSet<Element>();

const bindProviderConfigEvent = (configElement: Element, root: Element) => {
    const togglePasswordIcon = configElement.querySelector('[data-action="togglePassword"]');
    togglePasswordIcon?.addEventListener("click", () => {
        const useElement = togglePasswordIcon.firstElementChild;
        const isEye = useElement.getAttribute("xlink:href") === "#iconEye";
        useElement.setAttribute("xlink:href", isEye ? "#iconEyeoff" : "#iconEye");
        (togglePasswordIcon.previousElementSibling as HTMLInputElement).setAttribute("type", isEye ? "text" : "password");
    });

    const importElement = configElement.querySelector("#importSyncConfig") as HTMLInputElement;
    importElement?.addEventListener("change", () => {
        const formData = new FormData();
        formData.append("file", importElement.files[0]);
        const isS3 = importElement.getAttribute("data-type") === "s3";
        fetchPost(isS3 ? "/api/sync/importSyncProviderS3" : "/api/sync/importSyncProviderWebDAV", formData, (response) => {
            if (isS3) {
                window.siyuan.config.sync.s3 = response.data.s3;
            } else {
                window.siyuan.config.sync.webdav = response.data.webdav;
            }
            renderProviderConfig(root);
            showMessage(window.siyuan.languages.imported);
        });
    });

    const exportButton = configElement.querySelector("#exportSyncConfig");
    exportButton?.addEventListener("click", () => {
        fetchPost(exportButton.getAttribute("data-type") === "s3" ? "/api/sync/exportSyncProviderS3" : "/api/sync/exportSyncProviderWebDAV", {}, (response) => {
            void saveExportFile(response.data.zip);
        });
    });

    configElement.querySelector("#purgeCloudData")?.addEventListener("click", () => {
        confirmDialog("♻️ " + window.siyuan.languages.cloudStoragePurge, `<div class="b3-typography">${window.siyuan.languages.cloudStoragePurgeConfirm}</div>`, () => {
            fetchPost("/api/repo/purgeCloudRepo");
        });
    });

    const provider = window.siyuan.config.sync.provider;
    const def = SYNC_PROVIDER_DEFS[provider];
    if (!isThirdPartySyncProviderDef(def) || !def.isProviderConfigAllowed()) {
        return;
    }
    fillSyncProviderConfigValues(configElement);
    if (syncProviderConfigBoundElements.has(configElement)) {
        return;
    }
    syncProviderConfigBoundElements.add(configElement);
    configElement.addEventListener("click", (event: Event) => {
        const target = event.target as HTMLElement;
        // 点击字段说明图标：以 snackbar 展示
        const tipElement = target.closest<HTMLElement>("[data-field-tip]");
        if (tipElement && configElement.contains(tipElement)) {
            event.preventDefault();
            event.stopPropagation();
            const tip = tipElement.getAttribute("data-field-tip") || "";
            if (tip) {
                showMessage(tip);
            }
            return;
        }
        const actionElement = target.closest<HTMLElement>("[data-action]");
        if (!actionElement) {
            return;
        }
        if (actionElement.dataset.action === "addSyncHeader") {
            const rowsElement = configElement.querySelector('[data-role="syncHeaderRows"]');
            rowsElement?.insertAdjacentHTML("beforeend", genSyncHeaderRow());
            return;
        }
        if (actionElement.dataset.action === "removeSyncHeader") {
            actionElement.closest('[data-role="syncHeaderRow"]')?.remove();
            saveSyncProviderConfigValues(configElement);
            return;
        }
        if (actionElement.dataset.action === "insertSyncPlaceholder") {
            const inputElement = actionElement.closest(".config-sync-placeholder")?.querySelector<HTMLInputElement>("input");
            if (inputElement) {
                insertSyncPlaceholder(inputElement, configElement);
            }
        }
    });
    configElement.addEventListener("change", (event: Event) => {
        const target = event.target as HTMLElement;
        if (!target.matches(".b3-text-field, .b3-select")) {
            return;
        }
        if (target.id === "dnsRecordType") {
            // 未选择 DNS 类型时禁用解析值输入；后端在类型或值为空时也会忽略指定解析
            updateDnsRecordValueDisabled(configElement);
        }
        saveSyncProviderConfigValues(configElement);
    });
};

// 未选择 DNS 解析记录类型时，禁用 DNS 解析记录值输入框
const updateDnsRecordValueDisabled = (configElement: Element) => {
    const typeElement = configElement.querySelector("#dnsRecordType") as HTMLSelectElement | null;
    const valueElement = configElement.querySelector("#dnsRecordValue") as HTMLInputElement | null;
    if (!typeElement || !valueElement) {
        return;
    }
    const disabled = !typeElement.value;
    valueElement.disabled = disabled;
    const placeholderBtn = valueElement.closest(".config-sync-placeholder")?.querySelector<HTMLButtonElement>('[data-action="insertSyncPlaceholder"]');
    if (placeholderBtn) {
        placeholderBtn.disabled = disabled;
    }
};

const saveSyncProviderConfigValues = (configElement: Element) => {
    const provider = window.siyuan.config.sync.provider;
    const def = SYNC_PROVIDER_DEFS[provider];
    if (!isThirdPartySyncProviderDef(def)) {
        return;
    }
    const data = readProviderConfigFields(configElement, def.getConfig());
    const configKey = def.configKey;
    // 使用 fetchSyncPost：内核返回 code < 0 时 fetchPost 不会调用回调，此处需始终回写界面与已保存配置一致
    fetchSyncPost(def.api, {[configKey]: data})
        .then((response) => {
            if (response.code === 0 && response.data?.[configKey]) {
                window.siyuan.config.sync[configKey] = response.data[configKey];
            }
        })
        .finally(() => {
            fillSyncProviderConfigValues(configElement);
        })
        .catch(() => {});
};

const fillSyncProviderConfigValues = (configElement: Element) => {
    const provider = window.siyuan.config.sync.provider;
    const def = SYNC_PROVIDER_DEFS[provider];
    if (!isThirdPartySyncProviderDef(def)) {
        return;
    }
    const data = def.getConfig() as Record<string, unknown>;
    (Object.keys(data) as string[]).forEach((key) => {
        const el = configElement.querySelector(`#${key}`) as HTMLInputElement | HTMLSelectElement | null;
        if (el) {
            // connectPort 为 0 / 缺省时留空展示，表示不覆盖 Endpoint 端口
            if (key === "connectPort") {
                const port = Number(data.connectPort);
                el.value = port > 0 ? String(port) : "";
            } else {
                el.value = String(data[key] ?? "");
            }
        }
    });
    // 旧配置对象可能还没有 connectPort 字段
    const connectPortEl = configElement.querySelector("#connectPort") as HTMLInputElement | null;
    if (connectPortEl && !("connectPort" in data)) {
        connectPortEl.value = "";
    }
    const headersElement = configElement.querySelector('[data-role="syncHeaderRows"]');
    if (headersElement && "headers" in data) {
        const headers = Array.isArray(data.headers) ? data.headers : [];
        headersElement.innerHTML = headers.map((header) => genSyncHeaderRow(header as Config.ISyncHeader)).join("");
    }
    updateDnsRecordValueDisabled(configElement);
};

const readProviderConfigFields = <T extends object>(configElement: Element, template: T): T => {
    const result = {} as Record<string, unknown>;
    (Object.keys(template) as (keyof T & string)[]).forEach((key) => {
        const el = configElement.querySelector(`#${key}`) as HTMLInputElement | HTMLSelectElement | null;
        if (!el) {
            return;
        }
        const sample = template[key];
        if (typeof sample === "boolean") {
            result[key] = el.value === "true";
        } else if (typeof sample === "number") {
            const raw = resolveSyncPlaceholderValue(el.value).trim();
            // connectPort 留空表示不覆盖，固定写回 0
            if (key === "connectPort") {
                if (!raw) {
                    result[key] = 0;
                    return;
                }
                const port = parseInt(raw, 10);
                result[key] = Number.isNaN(port) || port < 1 || port > 65535 ? 0 : port;
                return;
            }
            const numberValue = parseInt(raw, 10);
            result[key] = Number.isNaN(numberValue) ? sample : numberValue;
        } else {
            result[key] = el.value;
        }
    });
    // 兼容旧配置对象尚无 connectPort 字段时，仍从表单读取指定 TCP 连接端口
    if (!("connectPort" in result)) {
        const connectPortEl = configElement.querySelector("#connectPort") as HTMLInputElement | null;
        if (connectPortEl) {
            const raw = resolveSyncPlaceholderValue(connectPortEl.value).trim();
            if (!raw) {
                result.connectPort = 0;
            } else {
                const port = parseInt(raw, 10);
                result.connectPort = Number.isNaN(port) || port < 1 || port > 65535 ? 0 : port;
            }
        }
    }
    if ("headers" in template) {
        result.headers = Array.from(configElement.querySelectorAll('[data-role="syncHeaderRow"]')).map((row) => {
            return {
                name: row.querySelector<HTMLInputElement>('[data-name="name"]')?.value || "",
                value: row.querySelector<HTMLInputElement>('[data-name="value"]')?.value || "",
            };
        }).filter((header) => header.name.trim() || header.value);
    }
    return result as T;
};

const insertSyncPlaceholder = (inputElement: HTMLInputElement, configElement: Element) => {
    const placeholders = getSyncPlaceholderOptions();
    if (placeholders.length === 0) {
        showMessage("请先在「密钥和变量」中添加密钥或变量");
        return;
    }
    const value = placeholders.length === 1 ? placeholders[0].value : window.prompt("输入要插入的密钥或变量占位符", placeholders[0].value);
    if (!value) {
        return;
    }
    const start = inputElement.selectionStart ?? inputElement.value.length;
    const end = inputElement.selectionEnd ?? inputElement.value.length;
    inputElement.value = `${inputElement.value.slice(0, start)}${value}${inputElement.value.slice(end)}`;
    inputElement.focus();
    inputElement.setSelectionRange(start + value.length, start + value.length);
    saveSyncProviderConfigValues(configElement);
};

const getSyncPlaceholderOptions = () => {
    const secrets = window.siyuan.config.secrets?.items || [];
    const variables = window.siyuan.config.variables?.items || [];
    return [
        ...secrets.map((item: SyncNamedItem) => ({label: `密钥 ${item.name}`, value: `{{secrets.${item.name}}}`})),
        ...variables.map((item: SyncNamedItem) => ({label: `变量 ${item.name}`, value: `{{vars.${item.name}}}`})),
    ].filter((item) => item.value !== "{{secrets.}}" && item.value !== "{{vars.}}");
};

const resolveSyncPlaceholderValue = (value: string) => {
    let ret = value;
    window.siyuan.config.secrets?.items?.forEach((item) => {
        ret = ret.replaceAll(`{{secrets.${item.name}}}`, item.value);
    });
    window.siyuan.config.variables?.items?.forEach((item) => {
        ret = ret.replaceAll(`{{vars.${item.name}}}`, item.value);
    });
    return ret;
};

const renderCloudSpace = (root: Element) => {
    const cloudSpaceElement = root.querySelector("#cloudSpace");
    if (!cloudSpaceElement) {
        return;
    }

    const isProviderOfficial = window.siyuan.config.sync.provider === 0;
    const subscribed = !needSubscribe("");
    const hidden = cloudSpaceElement.classList.toggle("fn__none", !isProviderOfficial || !subscribed);
    if (!hidden) {
        cloudSpaceElement.innerHTML = buildCloudSpaceHtml(
            Object.fromEntries(CLOUD_SPACE_DISPLAY_KEYS.map((key) => [key, "0B"])) as CloudSpaceDisplayData,
            true
        );
        fetchSyncPost("/api/cloud/getCloudSpace").then((response) => {
            if (response.code === 1) {
                cloudSpaceElement.innerHTML = `<span class="ft__error">${response.msg}</span>`;
                return;
            }
            if (response.code !== 0 || !response.data) {
                return;
            }
            cloudSpaceElement.innerHTML = buildCloudSpaceHtml({
                syncSize: response.data.sync.hSize,
                backupSize: response.data.backup.hSize,
                hAssetSize: response.data.hAssetSize,
                hSize: response.data.hSize,
                hTotalSize: response.data.hTotalSize,
                hExchangeSize: response.data.hExchangeSize,
                hTrafficUploadSize: response.data.hTrafficUploadSize,
                hTrafficDownloadSize: response.data.hTrafficDownloadSize,
                hTrafficAPIGet: response.data.hTrafficAPIGet,
                hTrafficAPIPut: response.data.hTrafficAPIPut,
            }, false);
        }).catch(() => {});
    }
};

const CLOUD_SPACE_DISPLAY_KEYS = [
    "syncSize",
    "backupSize",
    "hAssetSize",
    "hSize",
    "hTotalSize",
    "hExchangeSize",
    "hTrafficUploadSize",
    "hTrafficDownloadSize",
    "hTrafficAPIGet",
    "hTrafficAPIPut",
] as const;

type CloudSpaceDisplayData = Record<(typeof CLOUD_SPACE_DISPLAY_KEYS)[number], string>;

const buildCloudSpaceHtml = (data: CloudSpaceDisplayData, loading: boolean) =>
    `<div class="fn__flex config-cloud-space${loading ? " config-cloud-space--loading" : ""}">
    <div class="config-cloud-space__body">
        ${window.siyuan.languages.cloudStorage}
        <div class="config-cloud-space__placeholder">
        <div class="fn__hr"></div>
        <ul class="b3-list">
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.sync}<span class="b3-list-item__meta">${data.syncSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.backup}<span class="b3-list-item__meta">${data.backupSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;"><a href="${getCloudURL("settings/file?type=3")}" target="_blank">${window.siyuan.languages.cdn}</a><span class="b3-list-item__meta">${data.hAssetSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.total}<span class="b3-list-item__meta">${data.hSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.sizeLimit}<span class="b3-list-item__meta">${data.hTotalSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;"><a href="${getCloudURL("settings/point")}" target="_blank">${window.siyuan.languages.pointExchangeSize}</a><span class="b3-list-item__meta">${data.hExchangeSize}</span></li>
        </ul>
        </div>
    </div>
    <div class="config-cloud-space__body">
        ${window.siyuan.languages.trafficStat}
        <div class="config-cloud-space__placeholder">
        <div class="fn__hr"></div>
        <ul class="b3-list">
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.upload}<span class="fn__space"></span><span class="ft__on-surface">${data.hTrafficUploadSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;">${window.siyuan.languages.download}<span class="fn__space"></span><span class="ft__on-surface">${data.hTrafficDownloadSize}</span></li>
            <li class="b3-list-item" style="cursor: auto;">API GET<span class="fn__space"></span><span class="ft__on-surface">${data.hTrafficAPIGet}</span></li>
            <li class="b3-list-item" style="cursor: auto;">API PUT<span class="fn__space"></span><span class="ft__on-surface">${data.hTrafficAPIPut}</span></li>
        </ul>
        </div>
    </div>
    ${loading ? '<div class="fn__loading"><img width="64px" src="/stage/loading-pure.svg"></div>' : ""}
</div>`;
