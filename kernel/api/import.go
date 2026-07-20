// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func importSY(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(200, ret)

	util.PushEndlessProgress(model.Conf.Language(73))
	defer util.ClearPushProgress(100)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("parse import .sy.zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	files := form.File["file"]
	if 1 > len(files) {
		logging.LogErrorf("parse import .sy.zip failed, no file found")
		ret.Code = -1
		ret.Msg = "no file found"
		return
	}
	file := files[0]
	importDir := filepath.Join(util.TempDir, "import")
	if err = os.MkdirAll(importDir, 0755); err != nil {
		logging.LogErrorf("make import dir [%s] failed: %s", importDir, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	writePath := filepath.Join(importDir, file.Filename)
	if !gulu.File.IsSubPath(importDir, writePath) {
		logging.LogErrorf("import path [%s] is not sub path of import dir [%s]", writePath, importDir)
		ret.Code = -1
		ret.Msg = "import path is not sub path of import dir"
		return
	}

	defer os.RemoveAll(writePath)

	var reader io.ReadCloser
	var writer *os.File
	defer func() {
		if writer != nil {
			_ = writer.Close()
		}
		if reader != nil {
			_ = reader.Close()
		}
	}()

	reader, err = file.Open()
	if err != nil {
		logging.LogErrorf("read import .sy.zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	writer, err = os.OpenFile(writePath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		logging.LogErrorf("open import .sy.zip [%s] failed: %s", writePath, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if _, err = io.Copy(writer, reader); err != nil {
		logging.LogErrorf("write import .sy.zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if err = writer.Close(); err != nil {
		logging.LogErrorf("close import .sy.zip [%s] failed: %s", writePath, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	writer = nil
	if err = reader.Close(); err != nil {
		logging.LogErrorf("close import upload reader failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	reader = nil

	notebook := form.Value["notebook"][0]
	toPath := form.Value["toPath"][0]

	err = model.ImportSY(writePath, notebook, toPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

func importData(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	util.PushEndlessProgress(model.Conf.Language(73))
	defer util.ClearPushProgress(100)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("import data failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	if 1 > len(form.File["file"]) {
		logging.LogErrorf("import data failed: %s", err)
		ret.Code = -1
		ret.Msg = "file not found"
		return
	}

	importDir := filepath.Join(util.TempDir, "import")
	err = os.MkdirAll(importDir, 0755)
	if err != nil {
		ret.Code = -1
		ret.Msg = "create temp import dir failed"
		return
	}
	dataZipPath := filepath.Join(importDir, util.CurrentTimeSecondsStr()+".zip")
	defer os.RemoveAll(dataZipPath)

	var dataZipFile *os.File
	var fileReader io.ReadCloser
	defer func() {
		if dataZipFile != nil {
			_ = dataZipFile.Close()
		}
		if fileReader != nil {
			_ = fileReader.Close()
		}
	}()

	dataZipFile, err = os.Create(dataZipPath)
	if err != nil {
		logging.LogErrorf("create temp file failed: %s", err)
		ret.Code = -1
		ret.Msg = "create temp file failed"
		return
	}
	file := form.File["file"][0]
	logging.LogInfof("import data [name=%s, size=%d]", file.Filename, file.Size)
	fileReader, err = file.Open()
	if err != nil {
		logging.LogErrorf("open upload file failed: %s", err)
		ret.Code = -1
		ret.Msg = "open file failed"
		return
	}
	_, err = io.Copy(dataZipFile, fileReader)
	if err != nil {
		logging.LogErrorf("read upload file failed: %s", err)
		ret.Code = -1
		ret.Msg = "read file failed"
		return
	}
	if err = dataZipFile.Close(); err != nil {
		logging.LogErrorf("close file failed: %s", err)
		ret.Code = -1
		ret.Msg = "close file failed"
		return
	}
	dataZipFile = nil
	if err = fileReader.Close(); err != nil {
		logging.LogErrorf("close upload reader failed: %s", err)
		ret.Code = -1
		ret.Msg = "close file failed"
		return
	}
	fileReader = nil

	err = model.ImportData(dataZipPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

func importStdMd(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook := arg["notebook"].(string)
	localPath := arg["localPath"].(string)
	toPath := arg["toPath"].(string)

	if gulu.File.IsSubPath(util.WorkingDir, localPath) {
		msg := fmt.Sprintf("import from local path [%s] failed: local path is sub path of working dir", localPath)
		logging.LogError(msg)
		ret.Code = -1
		ret.Msg = msg
		return
	}

	if util.IsSensitivePath(localPath) {
		msg := fmt.Sprintf("import from local path [%s] failed: local path is sensitive path", localPath)
		logging.LogError(msg)
		ret.Code = -1
		ret.Msg = msg
		return
	}

	err := model.ImportFromLocalPath(notebook, localPath, toPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

func importZipMd(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(200, ret)

	util.PushEndlessProgress(model.Conf.Language(73))
	defer util.ClearPushProgress(100)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("parse import .zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	files := form.File["file"]
	if 1 > len(files) {
		logging.LogErrorf("parse import .zip failed, no file found")
		ret.Code = -1
		ret.Msg = "no file found"
		return
	}
	file := files[0]
	importDir := filepath.Join(util.TempDir, "import")
	if err = os.MkdirAll(importDir, 0755); err != nil {
		logging.LogErrorf("make import dir [%s] failed: %s", importDir, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	writePath := filepath.Join(importDir, file.Filename)
	if !gulu.File.IsSubPath(importDir, writePath) {
		logging.LogErrorf("import path [%s] is not sub path of import dir [%s]", writePath, importDir)
		ret.Code = -1
		ret.Msg = "import path is not sub path of import dir"
		return
	}

	defer os.RemoveAll(writePath)

	var reader io.ReadCloser
	var writer *os.File
	defer func() {
		if writer != nil {
			_ = writer.Close()
		}
		if reader != nil {
			_ = reader.Close()
		}
	}()

	reader, err = file.Open()
	if err != nil {
		logging.LogErrorf("read import .zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	writer, err = os.OpenFile(writePath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		logging.LogErrorf("open import .zip [%s] failed: %s", writePath, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if _, err = io.Copy(writer, reader); err != nil {
		logging.LogErrorf("write import .zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if err = writer.Close(); err != nil {
		logging.LogErrorf("close import .zip [%s] failed: %s", writePath, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	writer = nil
	if err = reader.Close(); err != nil {
		logging.LogErrorf("close import upload reader failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	reader = nil

	notebook := form.Value["notebook"][0]
	toPath := form.Value["toPath"][0]

	// 准备解压路径
	filenameMain := strings.TrimSuffix(file.Filename, filepath.Ext(file.Filename))
	unzipPath := filepath.Join(util.TempDir, "import", filenameMain)

	defer os.RemoveAll(unzipPath)

	// 解压 writePath 的 zip 到 unzipPath
	err = gulu.Zip.Unzip(writePath, unzipPath)
	if err != nil {
		logging.LogErrorf("unzip import .zip failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	// 调用本地导入逻辑
	err = model.ImportFromLocalPath(notebook, unzipPath, toPath)

	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

// importMdFiles 接收浏览器/移动端上传的 Markdown 单文件或多文件（文件夹），
// 在临时目录重建相对路径后调用 ImportFromLocalPath。
// 表单字段：file（可多个）、paths（可选，与 file 一一对应的相对路径）、notebook、toPath。
func importMdFiles(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	util.PushEndlessProgress(model.Conf.Language(73))
	defer util.ClearPushProgress(100)

	form, err := c.MultipartForm()
	if err != nil {
		logging.LogErrorf("parse import markdown files failed: %s", err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	files := form.File["file"]
	if 1 > len(files) {
		logging.LogErrorf("parse import markdown files failed, no file found")
		ret.Code = -1
		ret.Msg = "no file found"
		return
	}

	if 1 > len(form.Value["notebook"]) || 1 > len(form.Value["toPath"]) {
		logging.LogErrorf("parse import markdown files failed, notebook or toPath is empty")
		ret.Code = -1
		ret.Msg = "notebook or toPath is empty"
		return
	}
	notebook := form.Value["notebook"][0]
	toPath := form.Value["toPath"][0]
	if "" == notebook || "" == toPath {
		ret.Code = -1
		ret.Msg = "notebook or toPath is empty"
		return
	}

	paths := form.Value["paths"]
	if 0 < len(paths) && len(paths) != len(files) {
		logging.LogErrorf("parse import markdown files failed, paths count [%d] != files count [%d]", len(paths), len(files))
		ret.Code = -1
		ret.Msg = "paths count does not match files count"
		return
	}

	importBase := filepath.Join(util.TempDir, "import", "mdfiles-"+gulu.Rand.String(7))
	if err = os.MkdirAll(importBase, 0755); err != nil {
		logging.LogErrorf("make import dir [%s] failed: %s", importBase, err)
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	defer os.RemoveAll(importBase)

	// 是否按「单文档」导入：仅 1 个文件且相对路径不含目录层级
	singleDoc := 1 == len(files)
	if singleDoc {
		relHint := files[0].Filename
		if 0 < len(paths) {
			relHint = paths[0]
		}
		relHint = filepath.ToSlash(strings.TrimSpace(relHint))
		if strings.Contains(relHint, "/") {
			singleDoc = false
		}
	}

	for i, file := range files {
		rel := file.Filename
		if 0 < len(paths) {
			rel = paths[i]
		}
		origRel := rel
		rel, cleanErr := sanitizeImportRelPath(rel)
		if nil != cleanErr {
			logging.LogErrorf("invalid import relative path [%s]: %s", origRel, cleanErr)
			ret.Code = -1
			ret.Msg = cleanErr.Error()
			return
		}

		// 单文档导入时只保留文件名，避免多余目录
		if singleDoc {
			rel = path.Base(filepath.ToSlash(rel))
			if "" == rel || "." == rel {
				ret.Code = -1
				ret.Msg = "invalid file name"
				return
			}
		}

		writePath := filepath.Join(importBase, filepath.FromSlash(rel))
		if !gulu.File.IsSubPath(importBase, writePath) {
			logging.LogErrorf("import path [%s] is not sub path of import dir [%s]", writePath, importBase)
			ret.Code = -1
			ret.Msg = "import path is not sub path of import dir"
			return
		}
		if err = os.MkdirAll(filepath.Dir(writePath), 0755); err != nil {
			logging.LogErrorf("make import file dir [%s] failed: %s", filepath.Dir(writePath), err)
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}

		var reader io.ReadCloser
		var writer *os.File
		reader, err = file.Open()
		if err != nil {
			logging.LogErrorf("read import markdown file failed: %s", err)
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		writer, err = os.OpenFile(writePath, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			_ = reader.Close()
			logging.LogErrorf("open import markdown file [%s] failed: %s", writePath, err)
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		_, err = io.Copy(writer, reader)
		closeErrW := writer.Close()
		closeErrR := reader.Close()
		if err != nil {
			logging.LogErrorf("write import markdown file failed: %s", err)
			ret.Code = -1
			ret.Msg = err.Error()
			return
		}
		if nil != closeErrW {
			logging.LogErrorf("close import markdown file [%s] failed: %s", writePath, closeErrW)
			ret.Code = -1
			ret.Msg = closeErrW.Error()
			return
		}
		if nil != closeErrR {
			logging.LogErrorf("close import upload reader failed: %s", closeErrR)
			ret.Code = -1
			ret.Msg = closeErrR.Error()
			return
		}
	}

	localPath := importBase
	if singleDoc {
		entries, readErr := os.ReadDir(importBase)
		if nil != readErr || 1 != len(entries) || entries[0].IsDir() {
			logging.LogErrorf("resolve single markdown import path failed: %v", readErr)
			ret.Code = -1
			ret.Msg = "resolve import path failed"
			return
		}
		localPath = filepath.Join(importBase, entries[0].Name())
	} else {
		// 若临时根下仅有一个顶层目录（webkitdirectory 常见形态），直接导入该目录以保留文件夹名
		entries, readErr := os.ReadDir(importBase)
		if nil == readErr && 1 == len(entries) && entries[0].IsDir() {
			localPath = filepath.Join(importBase, entries[0].Name())
		}
	}

	err = model.ImportFromLocalPath(notebook, localPath, toPath)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
}

// sanitizeImportRelPath 规范化并校验上传文件的相对路径，拒绝绝对路径与路径穿越。
func sanitizeImportRelPath(rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	if "" == rel {
		return "", fmt.Errorf("empty relative path")
	}
	rel = filepath.ToSlash(rel)
	rel = strings.TrimPrefix(rel, "/")
	if "" == rel {
		return "", fmt.Errorf("empty relative path")
	}
	// 拒绝盘符与 URL 形态
	if strings.Contains(rel, "://") || (len(rel) > 1 && rel[1] == ':') {
		return "", fmt.Errorf("invalid relative path")
	}
	parts := strings.Split(rel, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if "" == part || "." == part {
			continue
		}
		if ".." == part {
			return "", fmt.Errorf("path traversal is not allowed")
		}
		// 剔除路径分隔与控制字符，避免异常文件名
		if strings.ContainsAny(part, `\:*?"<>|`) {
			return "", fmt.Errorf("invalid path segment")
		}
		cleanParts = append(cleanParts, part)
	}
	if 1 > len(cleanParts) {
		return "", fmt.Errorf("empty relative path")
	}
	return strings.Join(cleanParts, "/"), nil
}
