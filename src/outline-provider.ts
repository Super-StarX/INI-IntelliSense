import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';

// 定义树视图中条目的类型
enum OutlineItemType {
    Directory,
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
    public sectionName?: string;
    public keyPath?: string;
    public data?: any; // 用于存储子级数据, 如目录下的文件或键下的子键

    constructor(
        label: string,
        itemType: OutlineItemType,
        filePath: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            sectionName?: string;
            keyPath?: string;
            lineNumber?: number;
            data?: any;
            description?: string;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.filePath = filePath;
        this.sectionName = options?.sectionName;
        this.keyPath = options?.keyPath;
        this.data = options?.data;
        this.description = options?.description;
        this.contextValue = OutlineItemType[itemType]; // 用于 'when' 子句

        // 设置图标
        this.iconPath = this.getIcon();

        // 设置点击条目时的命令
        if (options?.lineNumber !== undefined) {
            const uri = vscode.Uri.file(this.filePath);
            const position = new vscode.Position(options.lineNumber, 0);
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
            case OutlineItemType.Directory:
                return new vscode.ThemeIcon('folder');
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
    async getChildren(element?: OutlineItem): Promise<OutlineItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showInformationMessage('No INI files in empty workspace');
            return [];
        }

        if (!element) {
            // 根级别: 构建并显示文件和目录树
            const filePaths = Array.from(this.iniManager.files.keys())
                .filter(p => !p.includes('INIConfigCheck.ini')); // 过滤掉字典文件

            const tree = this.buildFileTree(filePaths);
            return this.createTreeItemsFromNode(tree, vscode.workspace.workspaceFolders[0].uri.fsPath);
        }

        const { itemType, filePath, data } = element;

        switch (itemType) {
            case OutlineItemType.Directory:
                // 目录级别: 显示其下的文件和子目录
                return this.createTreeItemsFromNode(data, filePath);
            
            case OutlineItemType.File:
                // 文件级别: 显示所有节(sections)
                const fileData = this.iniManager.files.get(filePath);
                if (!fileData?.parsed) {return [];}
                
                const sections = Object.keys(fileData.parsed);
                return sections.map(sectionName => {
                    const lineNumber = this.iniManager.findSectionInContent(fileData.content, sectionName) ?? 0;
                    return new OutlineItem(`[${sectionName}]`, OutlineItemType.Section, filePath, vscode.TreeItemCollapsibleState.Collapsed, { sectionName, lineNumber });
                });

            case OutlineItemType.Section:
            case OutlineItemType.Key:
                // 节或键级别: 递归显示其下的键(keys)
                const parentData = itemType === OutlineItemType.Section
                    ? this.iniManager.files.get(filePath)?.parsed[element.sectionName!]
                    : data;

                if (typeof parentData !== 'object' || parentData === null) {return [];}

                return Object.entries(parentData).map(([key, value]) => {
                    const isObject = typeof value === 'object' && value !== null;
                    const newKeyPath = element.keyPath ? `${element.keyPath}.${key}` : key;
                    const lineNumber = this.findKeyLineNumber(this.iniManager.files.get(filePath)!.content, element.sectionName!, newKeyPath);

                    return new OutlineItem(
                        key,
                        OutlineItemType.Key,
                        filePath,
                        isObject ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        {
                            sectionName: element.sectionName,
                            keyPath: newKeyPath,
                            lineNumber,
                            data: isObject ? value : undefined,
                            description: isObject ? '' : String(value)
                        }
                    );
                });
        }

        return [];
    }

    /**
     * 将文件路径列表构建成一个嵌套的树状对象
     * @param filePaths 文件路径数组
     */
    private buildFileTree(filePaths: string[]): any {
        const tree: { [key: string]: any } = {};
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

        for (const filePath of filePaths) {
            const relativePath = path.relative(workspaceRoot, filePath);
            const parts = relativePath.split(path.sep);
            let currentNode: { [key: string]: any } = tree; 

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!currentNode[part]) {
                    currentNode[part] = i === parts.length - 1 ? { __is_file__: true, __full_path__: filePath } : {};
                }
                currentNode = currentNode[part];
            }
        }
        return tree;
    }

    /**
     * 从树节点创建 TreeItem 数组
     * @param node 当前树节点
     * @param parentPath 父路径
     */
    private createTreeItemsFromNode(node: any, parentPath: string): OutlineItem[] {
        const items = Object.entries(node).map(([name, childNode]: [string, any]) => {
            const currentPath = path.join(parentPath, name);
            if (childNode.__is_file__) {
                return new OutlineItem(name, OutlineItemType.File, childNode.__full_path__, vscode.TreeItemCollapsibleState.Collapsed);
            } else {
                return new OutlineItem(name, OutlineItemType.Directory, currentPath, vscode.TreeItemCollapsibleState.Collapsed, { data: childNode });
            }
        });

        // 排序: 目录在前, 文件在后, 然后按字母顺序
        return items.sort((a, b) => {
            if (a.itemType !== b.itemType) {
                return a.itemType === OutlineItemType.Directory ? -1 : 1;
            }
            return String(a.label!).localeCompare(String(b.label!));
        });
    }

    /**
     * 在文件内容中查找指定节内特定键(包括嵌套键)的行号
     * @param content 文件全文内容
     * @param sectionName 节名
     * @param keyPath 完整的键路径, 如 "Audio.Sub.Another"
     * @returns 行号 (从0开始), 未找到则返回0
     */
    private findKeyLineNumber(content: string, sectionName: string, keyPath: string): number {
        const lines = content.split(/\r?\n/);
        let inSection = false;
        
        // 转义正则表达式特殊字符
        const escapeRegex = (str: string) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        
        const sectionRegex = new RegExp(`^\\[${escapeRegex(sectionName)}\\]`);
        // 点号在正则表达式中是特殊字符, 需要转义
        const keyRegex = new RegExp(`^\\s*${escapeRegex(keyPath).replace(/\./g, '\\.')}\\s*=`);
        const nextSectionRegex = /^\s*\[.+\]/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]; // 不 trim(), 以便匹配行首空格
            if (sectionRegex.test(line.trim())) {
                inSection = true;
                continue;
            }
            
            if (inSection) {
                if (keyRegex.test(line)) {
                    return i; // 找到键, 返回行号
                }
                // 如果在节内遇到了下一个节的开始, 则停止搜索
                if (nextSectionRegex.test(line.trim())) {
                    break;
                }
            }
        }
        // 如果找不到精确匹配, 回退到查找节的行号
        const sectionLine = this.iniManager.findSectionInContent(content, sectionName);
        return sectionLine !== null ? sectionLine : 0;
    }
}