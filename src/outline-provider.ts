import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';

// 定义树视图中条目的类型
enum OutlineItemType {
    File,
    Section,
    Key
}

/**
 * 代表大纲视图中的一个可显示条目
 */
class OutlineItem extends vscode.TreeItem {
    public itemType: OutlineItemType;
    public filePath: string;
    public sectionName?: string; // 仅对 Key 类型有意义

    constructor(
        label: string,
        itemType: OutlineItemType,
        filePath: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        sectionName?: string,
        lineNumber?: number
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.filePath = filePath;
        this.sectionName = sectionName;
        this.contextValue = OutlineItemType[itemType]; // 用于 'when' 子句

        // 设置图标
        this.iconPath = this.getIcon();

        // 设置点击条目时的命令
        if (lineNumber !== undefined) {
            const uri = vscode.Uri.file(this.filePath);
            const position = new vscode.Position(lineNumber, 0);
            this.command = {
                command: 'vscode.open',
                title: 'Go to Definition',
                arguments: [uri, { selection: new vscode.Range(position, position) }]
            };
        }
    }

    /**
     * 根据条目类型返回对应的 Codicon 图标
     */
    private getIcon(): vscode.ThemeIcon {
        switch (this.itemType) {
            case OutlineItemType.File:
                return new vscode.ThemeIcon('notebook');
            case OutlineItemType.Section:
                return new vscode.ThemeIcon('symbol-namespace');
            case OutlineItemType.Key:
                return new vscode.ThemeIcon('symbol-key');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

/**
 * 为 INI 文件提供大纲视图的数据
 */
export class INIOutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<OutlineItem | undefined | null | void> = new vscode.EventEmitter<OutlineItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<OutlineItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext, private iniManager: INIManager) {}

    /**
     * 刷新整个树视图
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: OutlineItem): vscode.TreeItem {
        return element;
    }

    /**
     * 获取指定元素的子元素
     * @param element 父元素, 如果为 undefined, 则获取根元素
     */
    getChildren(element?: OutlineItem): Thenable<OutlineItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showInformationMessage('No INI files in empty workspace');
            return Promise.resolve([]);
        }

        if (!element) {
            // 根级别: 显示所有 INI 文件
            const filePaths = Array.from(this.iniManager.files.keys());
            const fileItems = filePaths
                .filter(p => !p.includes('INIConfigCheck.ini')) // 过滤掉字典文件
                .map(filePath => {
                    const label = path.basename(filePath);
                    return new OutlineItem(label, OutlineItemType.File, filePath, vscode.TreeItemCollapsibleState.Collapsed);
                });
            // 按字母顺序排序
            return Promise.resolve(fileItems.sort((a, b) => a.label!.localeCompare(b.label!)));
        } else {
            const fileData = this.iniManager.files.get(element.filePath);
            if (!fileData) {
                return Promise.resolve([]);
            }

            if (element.itemType === OutlineItemType.File) {
                // 文件级别: 显示所有节(sections)
                const sections = Object.keys(fileData.parsed);
                const sectionItems = sections.map(sectionName => {
                    const lineNumber = this.iniManager.findSectionInContent(fileData.content, sectionName) ?? 0;
                    return new OutlineItem(`[${sectionName}]`, OutlineItemType.Section, element.filePath, vscode.TreeItemCollapsibleState.Collapsed, sectionName, lineNumber);
                });
                return Promise.resolve(sectionItems);
            } else if (element.itemType === OutlineItemType.Section && element.sectionName) {
                // 节级别: 显示所有键(keys)
                const sectionContent = fileData.parsed[element.sectionName];
                if (typeof sectionContent !== 'object' || sectionContent === null) {
                    return Promise.resolve([]);
                }
                const keys = Object.keys(sectionContent);
                const keyItems = keys.map(keyName => {
                    const lineNumber = this.findKeyLineNumber(fileData.content, element.sectionName!, keyName);
                    return new OutlineItem(keyName, OutlineItemType.Key, element.filePath, vscode.TreeItemCollapsibleState.None, undefined, lineNumber);
                });
                return Promise.resolve(keyItems);
            }
        }

        return Promise.resolve([]);
    }

    /**
     * 在文件内容中查找指定节内特定键的行号
     * 这是一个简化的实现, 假设键在节内是唯一的
     * @param content 文件全文内容
     * @param sectionName 节名
     * @param keyName 键名
     * @returns 行号 (从0开始), 未找到则返回0
     */
    private findKeyLineNumber(content: string, sectionName: string, keyName: string): number {
        const lines = content.split(/\r?\n/);
        let inSection = false;
        const sectionRegex = new RegExp(`^\\[${sectionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\]`);
        const keyRegex = new RegExp(`^\\s*${keyName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*=`);
        const nextSectionRegex = /^\s*\[.+\]/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (sectionRegex.test(line)) {
                inSection = true;
                continue;
            }
            
            if (inSection) {
                if (keyRegex.test(line)) {
                    return i; // 找到键, 返回行号
                }
                // 如果在节内遇到了下一个节的开始, 则停止搜索
                if (nextSectionRegex.test(line)) {
                    break;
                }
            }
        }
        return 0; // 默认返回
    }
}