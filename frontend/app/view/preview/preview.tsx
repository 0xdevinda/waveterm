// Copyright 2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { TypeAheadModal } from "@/app/modals/typeaheadmodal";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { Markdown } from "@/element/markdown";
import { createBlock, globalStore, useBlockAtom } from "@/store/global";
import * as services from "@/store/services";
import * as WOS from "@/store/wos";
import { getWebServerEndpoint } from "@/util/endpoints";
import * as historyutil from "@/util/historyutil";
import * as keyutil from "@/util/keyutil";
import * as util from "@/util/util";
import clsx from "clsx";
import * as jotai from "jotai";
import { loadable } from "jotai/utils";
import { createRef, useCallback, useEffect, useState } from "react";
import { CenteredDiv } from "../../element/quickelems";
import { CodeEditor } from "../codeeditor/codeeditor";
import { CSVView } from "./csvview";
import { DirectoryPreview } from "./directorypreview";

import "./preview.less";

const MaxFileSize = 1024 * 1024 * 10; // 10MB
const MaxCSVSize = 1024 * 1024 * 1; // 1MB

function isTextFile(mimeType: string): boolean {
    return (
        mimeType.startsWith("text/") ||
        mimeType == "application/sql" ||
        (mimeType.startsWith("application/") &&
            (mimeType.includes("json") || mimeType.includes("yaml") || mimeType.includes("toml"))) ||
        mimeType == "application/pem-certificate-chain"
    );
}

function canPreview(mimeType: string): boolean {
    return mimeType.startsWith("text/markdown") || mimeType.startsWith("text/csv");
}

export class PreviewModel implements ViewModel {
    viewType: string;
    blockId: string;
    blockAtom: jotai.Atom<Block>;
    viewIcon: jotai.Atom<string | HeaderIconButton>;
    viewName: jotai.Atom<string>;
    viewText: jotai.Atom<HeaderElem[]>;
    preIconButton: jotai.Atom<HeaderIconButton>;
    endIconButtons: jotai.Atom<HeaderIconButton[]>;
    ceReadOnly: jotai.PrimitiveAtom<boolean>;
    previewTextRef: React.RefObject<HTMLDivElement>;
    editMode: jotai.Atom<boolean>;
    canPreview: jotai.PrimitiveAtom<boolean>;

    fileName: jotai.Atom<string>;
    connection: jotai.Atom<string>;
    statFile: jotai.Atom<Promise<FileInfo>>;
    fullFile: jotai.Atom<Promise<FullFile>>;
    fileMimeType: jotai.Atom<Promise<string>>;
    fileMimeTypeLoadable: jotai.Atom<Loadable<string>>;
    fileContent: jotai.Atom<Promise<string>>;
    newFileContent: jotai.PrimitiveAtom<string | null>;
    openFileModal: jotai.PrimitiveAtom<boolean>;

    showHiddenFiles: jotai.PrimitiveAtom<boolean>;
    refreshVersion: jotai.PrimitiveAtom<number>;
    refreshCallback: () => void;
    directoryKeyDownHandler: (waveEvent: WaveKeyboardEvent) => boolean;

    setPreviewFileName(fileName: string) {
        services.ObjectService.UpdateObjectMeta(`block:${this.blockId}`, { file: fileName });
    }

    constructor(blockId: string) {
        this.viewType = "preview";
        this.blockId = blockId;
        this.showHiddenFiles = jotai.atom(true);
        this.refreshVersion = jotai.atom(0);
        this.previewTextRef = createRef();
        this.ceReadOnly = jotai.atom(true);
        this.canPreview = jotai.atom(false);
        this.openFileModal = jotai.atom(false);
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom((get) => {
            let blockData = get(this.blockAtom);
            if (blockData?.meta?.icon) {
                return blockData.meta.icon;
            }
            const mimeType = util.jotaiLoadableValue(get(this.fileMimeTypeLoadable), "");
            if (mimeType == "directory") {
                return {
                    elemtype: "iconbutton",
                    icon: "folder-open",
                    longClick: (e: React.MouseEvent<any>) => {
                        let menuItems: ContextMenuItem[] = [];
                        menuItems.push({
                            label: "Go to Home",
                            click: () => this.goHistory("~"),
                        });
                        menuItems.push({
                            label: "Go to Desktop",
                            click: () => this.goHistory("~/Desktop"),
                        });
                        menuItems.push({
                            label: "Go to Downloads",
                            click: () => this.goHistory("~/Downloads"),
                        });
                        menuItems.push({
                            label: "Go to Documents",
                            click: () => this.goHistory("~/Documents"),
                        });
                        menuItems.push({
                            label: "Go to Root",
                            click: () => this.goHistory("/"),
                        });
                        ContextMenuModel.showContextMenu(menuItems, e);
                    },
                };
            }
            const fileName = get(this.fileName);
            return iconForFile(mimeType, fileName);
        });
        this.editMode = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            return blockData?.meta?.edit ?? false;
        });
        this.viewName = jotai.atom("Preview");
        this.viewText = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const editMode = blockData?.meta?.edit ?? false;
            const viewTextChildren: HeaderElem[] = [
                {
                    elemtype: "text",
                    text: get(this.fileName),
                    ref: this.previewTextRef,
                    className: "preview-filename",
                    onClick: () => globalStore.set(this.openFileModal, true),
                },
            ];
            let saveClassName = "secondary";
            if (get(this.newFileContent) !== null) {
                saveClassName = "primary";
            }
            if (editMode) {
                viewTextChildren.push({
                    elemtype: "textbutton",
                    text: "Save",
                    className: clsx(
                        `${saveClassName} warning border-radius-4 vertical-padding-2 horizontal-padding-10 font-size-11 font-weight-500`
                    ),
                    onClick: this.handleFileSave.bind(this),
                });
                if (get(this.canPreview)) {
                    viewTextChildren.push({
                        elemtype: "textbutton",
                        text: "Preview",
                        className:
                            "secondary border-radius-4 vertical-padding-2 horizontal-padding-10 font-size-11 font-weight-500",
                        onClick: () => this.toggleEditMode(false),
                    });
                }
            } else if (get(this.canPreview)) {
                viewTextChildren.push({
                    elemtype: "textbutton",
                    text: "Edit",
                    className:
                        "secondary border-radius-4 vertical-padding-2 horizontal-padding-10 font-size-11 font-weight-500",
                    onClick: () => this.toggleEditMode(true),
                });
            }
            return [
                {
                    elemtype: "div",
                    children: viewTextChildren,
                },
            ] as HeaderElem[];
        });
        this.preIconButton = jotai.atom((get) => {
            const mimeType = util.jotaiLoadableValue(get(this.fileMimeTypeLoadable), "");
            if (mimeType == "directory") {
                return null;
            }
            return {
                elemtype: "iconbutton",
                icon: "chevron-left",
                click: this.goParentDirectory.bind(this),
            };
        });
        this.endIconButtons = jotai.atom((get) => {
            const mimeType = util.jotaiLoadableValue(get(this.fileMimeTypeLoadable), "");
            if (mimeType == "directory") {
                let showHiddenFiles = get(this.showHiddenFiles);
                return [
                    {
                        elemtype: "iconbutton",
                        icon: showHiddenFiles ? "eye" : "eye-slash",
                        click: () => {
                            globalStore.set(this.showHiddenFiles, (prev) => !prev);
                        },
                    },
                    {
                        elemtype: "iconbutton",
                        icon: "arrows-rotate",
                        click: () => this.refreshCallback?.(),
                    },
                ];
            }
            return null;
        });
        this.fileName = jotai.atom<string>((get) => {
            const file = get(this.blockAtom)?.meta?.file;
            if (util.isBlank(file)) {
                return "~";
            }
            return file;
        });
        this.connection = jotai.atom<string>((get) => {
            return get(this.blockAtom)?.meta?.connection;
        });
        this.statFile = jotai.atom<Promise<FileInfo>>(async (get) => {
            const fileName = get(this.fileName);
            if (fileName == null) {
                return null;
            }
            const conn = get(this.connection) ?? "";
            const statFile = await services.FileService.StatFile(conn, fileName);
            return statFile;
        });
        this.fileMimeType = jotai.atom<Promise<string>>(async (get) => {
            const fileInfo = await get(this.statFile);
            return fileInfo?.mimetype;
        });
        this.fileMimeTypeLoadable = loadable(this.fileMimeType);
        this.newFileContent = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.goParentDirectory = this.goParentDirectory.bind(this);
        this.toggleEditMode(false);
        this.setFileContent();
    }

    async resolvePath(filePath, basePath) {
        // Handle paths starting with "~" to refer to the home directory
        if (filePath.startsWith("~")) {
            try {
                const conn = globalStore.get(this.connection);
                const sf = await services.FileService.StatFile(conn, "~");
                basePath = sf.path; // Update basePath to the fetched home directory path
                filePath = basePath + filePath.slice(1); // Replace "~" with the fetched home directory path
            } catch (error) {
                console.error("Error fetching home directory:", error);
                return basePath;
            }
        }
        // If filePath is an absolute path, return it directly
        if (filePath.startsWith("/")) {
            return filePath;
        }
        const stack = basePath.split("/");
        // Ensure no empty segments from trailing slashes
        if (stack[stack.length - 1] === "") {
            stack.pop();
        }
        // Process the filePath parts
        filePath.split("/").forEach((part) => {
            if (part === "..") {
                // Go up one level, avoid going above root level
                if (stack.length > 1) {
                    stack.pop();
                }
            } else if (part === "." || part === "") {
                // Ignore current directory marker and empty parts
            } else {
                // Normal path part, add to the stack
                stack.push(part);
            }
        });
        console.log("===============================", stack.join("/"));
        return stack.join("/");
    }

    async isValidPath(path) {
        try {
            const conn = globalStore.get(this.connection);
            const sf = await services.FileService.StatFile(conn, path);
            const isValid = !sf.notfound;
            return isValid;
        } catch (error) {
            console.error("Error checking path validity:", error);
            return false;
        }
    }

    async goHistory(newPath, isValidated = false) {
        const fileName = globalStore.get(this.fileName);
        if (fileName == null) {
            return;
        }
        if (!isValidated) {
            newPath = await this.resolvePath(newPath, fileName);
            const isValid = await this.isValidPath(newPath);
            if (!isValid) {
                return;
            }
        }
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const updateMeta = historyutil.goHistory("file", fileName, newPath, blockMeta);
        if (updateMeta == null) {
            return;
        }
        const blockOref = WOS.makeORef("block", this.blockId);
        services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    goParentDirectory() {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const fileName = globalStore.get(this.fileName);
        if (fileName == null) {
            return;
        }
        const newPath = historyutil.getParentDirectory(fileName);
        const updateMeta = historyutil.goHistory("file", fileName, newPath, blockMeta);
        if (updateMeta == null) {
            return;
        }
        updateMeta.edit = false;
        const blockOref = WOS.makeORef("block", this.blockId);
        services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    goHistoryBack() {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const curPath = globalStore.get(this.fileName);
        const updateMeta = historyutil.goHistoryBack("file", curPath, blockMeta, true);
        if (updateMeta == null) {
            return;
        }
        updateMeta.edit = false;
        const blockOref = WOS.makeORef("block", this.blockId);
        services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    goHistoryForward() {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const curPath = globalStore.get(this.fileName);
        const updateMeta = historyutil.goHistoryForward("file", curPath, blockMeta);
        if (updateMeta == null) {
            return;
        }
        updateMeta.edit = false;
        const blockOref = WOS.makeORef("block", this.blockId);
        services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    setFileContent() {
        const fullFileAtom = jotai.atom<Promise<FullFile>>(async (get) => {
            const fileName = get(this.fileName);
            if (fileName == null) {
                return null;
            }
            const conn = get(this.connection) ?? "";
            const file = await services.FileService.ReadFile(conn, fileName);
            return file;
        });

        const fileContentAtom = jotai.atom<Promise<string>>(async (get) => {
            const fullFile = await get(fullFileAtom);
            return util.base64ToString(fullFile?.data64);
        });

        this.fullFile = fullFileAtom;
        this.fileContent = fileContentAtom;
    }

    toggleEditMode(edit: boolean) {
        if (!edit) {
            this.setFileContent();
        }

        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const blockOref = WOS.makeORef("block", this.blockId);
        services.ObjectService.UpdateObjectMeta(blockOref, { ...blockMeta, edit });
    }

    async handleFileSave() {
        const fileName = globalStore.get(this.fileName);
        const newFileContent = globalStore.get(this.newFileContent);
        const conn = globalStore.get(this.connection) ?? "";
        try {
            if (newFileContent != null) {
                services.FileService.SaveFile(conn, fileName, util.stringToBase64(newFileContent));
                globalStore.set(this.newFileContent, null);
            }
        } catch (error) {
            console.error("Error saving file:", error);
        }
    }

    getSettingsMenuItems(): ContextMenuItem[] {
        const menuItems: ContextMenuItem[] = [];
        menuItems.push({
            label: "Copy Full Path",
            click: () => {
                const fileName = globalStore.get(this.fileName);
                if (fileName == null) {
                    return;
                }
                navigator.clipboard.writeText(fileName);
            },
        });
        menuItems.push({
            label: "Copy File Name",
            click: () => {
                let fileName = globalStore.get(this.fileName);
                if (fileName == null) {
                    return;
                }
                if (fileName.endsWith("/")) {
                    fileName = fileName.substring(0, fileName.length - 1);
                }
                const splitPath = fileName.split("/");
                const baseName = splitPath[splitPath.length - 1];
                navigator.clipboard.writeText(baseName);
            },
        });
        const mimeType = util.jotaiLoadableValue(globalStore.get(this.fileMimeTypeLoadable), "");
        if (mimeType == "directory") {
            menuItems.push({
                label: "Open Terminal in New Block",
                click: async () => {
                    const termBlockDef: BlockDef = {
                        meta: {
                            view: "term",
                            controller: "shell",
                            "cmd:cwd": globalStore.get(this.fileName),
                        },
                    };
                    await createBlock(termBlockDef);
                },
            });
        }
        return menuItems;
    }

    giveFocus(): boolean {
        return false;
    }

    keyDownHandler(e: WaveKeyboardEvent): boolean {
        if (keyutil.checkKeyPressed(e, "Cmd:ArrowLeft")) {
            this.goHistoryBack();
            return true;
        }
        if (keyutil.checkKeyPressed(e, "Cmd:ArrowRight")) {
            this.goHistoryForward();
            return true;
        }
        if (keyutil.checkKeyPressed(e, "Cmd:ArrowUp")) {
            // handle up directory
            this.goParentDirectory();
            return true;
        }
        if (this.directoryKeyDownHandler) {
            const handled = this.directoryKeyDownHandler(e);
            if (handled) {
                return true;
            }
        }
        return false;
    }
}

function makePreviewModel(blockId: string): PreviewModel {
    const previewModel = new PreviewModel(blockId);
    return previewModel;
}

function DirNav({ cwdAtom }: { cwdAtom: jotai.WritableAtom<string, [string], void> }) {
    const [cwd, setCwd] = jotai.useAtom(cwdAtom);
    if (cwd == null || cwd == "") {
        return null;
    }
    let splitNav = [cwd];
    let remaining = cwd;

    let idx = remaining.lastIndexOf("/");
    while (idx !== -1) {
        remaining = remaining.substring(0, idx);
        splitNav.unshift(remaining);

        idx = remaining.lastIndexOf("/");
    }
    if (splitNav.length === 0) {
        splitNav = [cwd];
    }
    return (
        <div className="view-nav">
            {splitNav.map((item, idx) => {
                let splitPath = item.split("/");
                if (splitPath.length === 0) {
                    splitPath = [item];
                }
                const isLast = idx == splitNav.length - 1;
                let baseName = splitPath[splitPath.length - 1];
                if (!isLast) {
                    baseName += "/";
                }
                return (
                    <div
                        className={clsx("view-nav-item", isLast ? "current-file" : "clickable")}
                        key={`nav-item-${item}`}
                        onClick={isLast ? null : () => setCwd(item)}
                    >
                        {baseName}
                    </div>
                );
            })}
            <div className="flex-spacer"></div>
        </div>
    );
}

function MarkdownPreview({ contentAtom }: { contentAtom: jotai.Atom<Promise<string>> }) {
    const readmeText = jotai.useAtomValue(contentAtom);
    return (
        <div className="view-preview view-preview-markdown">
            <Markdown text={readmeText} />
        </div>
    );
}

function StreamingPreview({ connection, fileInfo }: { connection?: string; fileInfo: FileInfo }) {
    const filePath = fileInfo.path;
    const usp = new URLSearchParams();
    usp.set("path", filePath);
    if (connection != null) {
        usp.set("connection", connection);
    }
    const streamingUrl = getWebServerEndpoint() + "/wave/stream-file?" + usp.toString();
    if (fileInfo.mimetype == "application/pdf") {
        return (
            <div className="view-preview view-preview-pdf">
                <iframe src={streamingUrl} width="95%" height="95%" name="pdfview" />
            </div>
        );
    }
    if (fileInfo.mimetype.startsWith("video/")) {
        return (
            <div className="view-preview view-preview-video">
                <video controls>
                    <source src={streamingUrl} />
                </video>
            </div>
        );
    }
    if (fileInfo.mimetype.startsWith("audio/")) {
        return (
            <div className="view-preview view-preview-audio">
                <audio controls>
                    <source src={streamingUrl} />
                </audio>
            </div>
        );
    }
    if (fileInfo.mimetype.startsWith("image/")) {
        return (
            <div className="view-preview view-preview-image">
                <img src={streamingUrl} />
            </div>
        );
    }
    return <CenteredDiv>Preview Not Supported</CenteredDiv>;
}

function CodeEditPreview({
    parentRef,
    contentAtom,
    filename,
    newFileContentAtom,
    model,
}: {
    parentRef: React.MutableRefObject<HTMLDivElement>;
    contentAtom: jotai.Atom<Promise<string>>;
    filename: string;
    newFileContentAtom: jotai.PrimitiveAtom<string>;
    model: PreviewModel;
}) {
    const fileContent = jotai.useAtomValue(contentAtom);
    const setNewFileContent = jotai.useSetAtom(newFileContentAtom);

    return (
        <CodeEditor
            parentRef={parentRef}
            text={fileContent}
            filename={filename}
            onChange={(text) => setNewFileContent(text)}
            onSave={() => model.handleFileSave()}
            onCancel={() => model.toggleEditMode(true)}
            onEdit={() => model.toggleEditMode(false)}
        />
    );
}

function CSVViewPreview({
    parentRef,
    contentAtom,
    filename,
    readonly,
}: {
    parentRef: React.MutableRefObject<HTMLDivElement>;
    contentAtom: jotai.Atom<Promise<string>>;
    filename: string;
    readonly: boolean;
}) {
    const fileContent = jotai.useAtomValue(contentAtom);
    return <CSVView parentRef={parentRef} readonly={true} content={fileContent} filename={filename} />;
}

function iconForFile(mimeType: string, fileName: string): string {
    if (mimeType == null) {
        mimeType = "unknown";
    }
    if (mimeType == "application/pdf") {
        return "file-pdf";
    } else if (mimeType.startsWith("image/")) {
        return "image";
    } else if (mimeType.startsWith("video/")) {
        return "film";
    } else if (mimeType.startsWith("audio/")) {
        return "headphones";
    } else if (mimeType.startsWith("text/markdown")) {
        return "file-lines";
    } else if (mimeType == "text/csv") {
        return "file-csv";
    } else if (
        mimeType.startsWith("text/") ||
        mimeType == "application/sql" ||
        (mimeType.startsWith("application/") &&
            (mimeType.includes("json") || mimeType.includes("yaml") || mimeType.includes("toml")))
    ) {
        return "file-code";
    } else if (mimeType === "directory") {
        if (fileName == "~" || fileName == "~/") {
            return "home";
        }
        return "folder-open";
    } else {
        return "file";
    }
}

function PreviewView({
    blockId,
    blockRef,
    contentRef,
    model,
}: {
    blockId: string;
    blockRef: React.RefObject<HTMLDivElement>;
    contentRef: React.RefObject<HTMLDivElement>;
    model: PreviewModel;
}) {
    const fileNameAtom = model.fileName;
    const statFileAtom = model.statFile;
    const fileMimeTypeAtom = model.fileMimeType;
    const fileContentAtom = model.fileContent;
    const newFileContentAtom = model.newFileContent;
    const editModeAtom = model.editMode;
    const openFileModalAtom = model.openFileModal;
    const canPreviewAtom = model.canPreview;

    const mimeType = jotai.useAtomValue(fileMimeTypeAtom) || "";
    const fileName = jotai.useAtomValue(fileNameAtom);
    const fileInfo = jotai.useAtomValue(statFileAtom);
    const conn = jotai.useAtomValue(model.connection);
    const editMode = jotai.useAtomValue(editModeAtom);
    const openFileModal = jotai.useAtomValue(openFileModalAtom);
    let blockIcon = iconForFile(mimeType, fileName);

    const [filePath, setFilePath] = useState("");
    const [openFileError, setOpenFileError] = useState("");

    // ensure consistent hook calls
    const specializedView = (() => {
        let view: React.ReactNode = null;
        blockIcon = iconForFile(mimeType, fileName);
        if (
            mimeType === "application/pdf" ||
            mimeType.startsWith("video/") ||
            mimeType.startsWith("audio/") ||
            mimeType.startsWith("image/")
        ) {
            view = <StreamingPreview connection={conn} fileInfo={fileInfo} />;
        } else if (!fileInfo) {
            view = <CenteredDiv>File Not Found{util.isBlank(fileName) ? null : JSON.stringify(fileName)}</CenteredDiv>;
        } else if (fileInfo.size > MaxFileSize) {
            view = <CenteredDiv>File Too Large to Preview</CenteredDiv>;
        } else if (mimeType === "text/markdown" && !editMode) {
            globalStore.set(canPreviewAtom, true);
            view = <MarkdownPreview contentAtom={fileContentAtom} />;
        } else if (mimeType === "text/csv" && !editMode) {
            globalStore.set(canPreviewAtom, true);
            if (fileInfo.size > MaxCSVSize) {
                view = <CenteredDiv>CSV File Too Large to Preview (1MB Max)</CenteredDiv>;
            } else {
                view = (
                    <CSVViewPreview
                        parentRef={contentRef}
                        contentAtom={fileContentAtom}
                        filename={fileName}
                        readonly={true}
                    />
                );
            }
        } else if (isTextFile(mimeType)) {
            model.toggleEditMode(true);
            view = (
                <CodeEditPreview
                    parentRef={contentRef}
                    contentAtom={fileContentAtom}
                    filename={fileName}
                    newFileContentAtom={newFileContentAtom}
                    model={model}
                />
            );
        } else if (mimeType === "directory") {
            view = <DirectoryPreview fileNameAtom={fileNameAtom} model={model} />;
            if (editMode) {
                globalStore.set(openFileModalAtom, true);
            } else {
                globalStore.set(canPreviewAtom, false);
            }
        } else {
            globalStore.set(canPreviewAtom, false);
            model.toggleEditMode(false);
            view = (
                <div className="view-preview">
                    <div>Preview ({mimeType})</div>
                </div>
            );
        }
        return view;
    })();

    const handleKeyDown = useCallback(
        (waveEvent: WaveKeyboardEvent): boolean => {
            const updateModalAndError = (isOpen, errorMsg = "") => {
                globalStore.set(openFileModalAtom, isOpen);
                setOpenFileError(errorMsg);
            };

            const handleEnterPress = async () => {
                const newPath = await model.resolvePath(filePath, fileName);
                const isValidPath = await model.isValidPath(newPath);
                if (isValidPath) {
                    updateModalAndError(false);
                    await model.goHistory(newPath, true);
                } else {
                    updateModalAndError(true, "The path you entered does not exist.");
                }
                model.giveFocus();
                return isValidPath;
            };

            const handleCommandOperations = async () => {
                if (keyutil.checkKeyPressed(waveEvent, "Cmd:o")) {
                    updateModalAndError(true);
                    return true;
                }
                if (keyutil.checkKeyPressed(waveEvent, "Cmd:d")) {
                    updateModalAndError(false);
                    return false;
                }
                if (keyutil.checkKeyPressed(waveEvent, "Enter")) {
                    return handleEnterPress();
                }
                return false;
            };

            handleCommandOperations().catch((error) => {
                console.error("Error handling key down:", error);
                updateModalAndError(true, "An error occurred during operation.");
                return false;
            });
            return false;
        },
        [model, blockId, filePath, fileName]
    );

    const handleFileSuggestionSelect = (value) => {
        globalStore.set(openFileModalAtom, false);
    };

    const handleFileSuggestionChange = (value) => {
        setFilePath(value);
    };

    const handleBackDropClick = () => {
        globalStore.set(openFileModalAtom, false);
    };

    useEffect(() => {
        const blockIconOverrideAtom = useBlockAtom<string>(blockId, "blockicon:override", () => {
            return jotai.atom<string>(null);
        }) as jotai.PrimitiveAtom<string>;
        globalStore.set(blockIconOverrideAtom, blockIcon);
    }, [blockId, blockIcon]);

    return (
        <>
            {openFileModal && (
                <TypeAheadModal
                    label="Open file"
                    suggestions={[]}
                    blockRef={blockRef}
                    anchorRef={model.previewTextRef}
                    onKeyDown={(e) => keyutil.keydownWrapper(handleKeyDown)(e)}
                    onSelect={handleFileSuggestionSelect}
                    onChange={handleFileSuggestionChange}
                    onClickBackdrop={handleBackDropClick}
                />
            )}
            <div
                className="full-preview scrollbar-hide-until-hover"
                onKeyDown={(e) => keyutil.keydownWrapper(handleKeyDown)(e)}
            >
                <div ref={contentRef} className="full-preview-content">
                    {specializedView}
                </div>
            </div>
        </>
    );
}

export { makePreviewModel, PreviewView };
