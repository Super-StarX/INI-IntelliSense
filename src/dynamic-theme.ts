import * as vscode from 'vscode';

/**
 * 管理动态语法高亮。
 * 此类负责读取用户配置的颜色，创建对应的文本装饰器，
 * 并在编辑器内容或配置变更时，应用这些装饰器。
 */
export class DynamicThemeManager implements vscode.Disposable {
    private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    private activeEditor = vscode.window.activeTextEditor;
    private timeout: NodeJS.Timeout | undefined = undefined;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.loadDecorationTypesFromConfig();

        if (this.activeEditor) {
            this.triggerUpdateDecorations();
        }

        // 监听活动编辑器变化
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            this.activeEditor = editor;
            if (editor) {
                this.triggerUpdateDecorations();
            }
        }));

        // 监听文本文档变化
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (this.activeEditor && event.document === this.activeEditor.document) {
                this.triggerUpdateDecorations(true);
            }
        }));
    }

    /**
     * 从 VS Code 配置中读取颜色设置，并创建或更新装饰器类型。
     */
    private loadDecorationTypesFromConfig() {
        // 清理旧的装饰器
        this.decorationTypes.forEach(d => d.dispose());
        this.decorationTypes.clear();

        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.colors');
        
        const colorMap: { [key: string]: string } = {
            'sectionBracket': config.get('sectionBracket')!,
            'sectionContent': config.get('sectionContent')!,
            'sectionInherit': config.get('sectionInherit')!,
            'keyPart1': config.get('keyPart1')!,
            'keyPart2': config.get('keyPart2')!,
            'keyPart3': config.get('keyPart3')!,
            'operator': config.get('operator')!,
            'value': config.get('value')!,
            'valueComma': config.get('valueComma')!,
            'valueString': config.get('valueString')!,
            'comment': config.get('comment')!,
        };
        
        for (const key in colorMap) {
            this.decorationTypes.set(key, vscode.window.createTextEditorDecorationType({ color: colorMap[key] }));
        }
    }

    /**
     * 当配置变更时，重新加载装饰器并更新所有可见编辑器。
     */
    public reloadDecorations() {
        this.loadDecorationTypesFromConfig();
        // 更新所有可见的INI编辑器
        vscode.window.visibleTextEditors.forEach(editor => {
            if (editor.document.languageId === 'ra2-ini') {
                this.updateDecorations(editor);
            }
        });
    }

    /**
     * 触发装饰器更新，使用防抖来避免过于频繁的刷新。
     * @param throttle 是否使用防抖
     */
    private triggerUpdateDecorations(throttle = false) {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        if (throttle) {
            this.timeout = setTimeout(() => {
                if(this.activeEditor) this.updateDecorations(this.activeEditor);
            }, 200);
        } else {
            if(this.activeEditor) this.updateDecorations(this.activeEditor);
        }
    }
    
    /**
     * 核心函数：解析文本并应用所有装饰器。
     * @param editor 要应用装饰器的文本编辑器
     */
    private updateDecorations(editor: vscode.TextEditor) {
        if (!editor || editor.document.languageId !== 'ra2-ini') {
            return;
        }

        const text = editor.document.getText();
        const decorationsMap = new Map<string, vscode.Range[]>();
        this.decorationTypes.forEach((_, key) => decorationsMap.set(key, []));

        const lines = text.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // 1. 匹配注释 (优先级最高, 找到后整行不再处理)
            const commentMatch = line.match(/;.*$/);
            if (commentMatch) {
                const range = new vscode.Range(i, commentMatch.index!, i, line.length);
                decorationsMap.get('comment')!.push(range);
            }
            const lineWithoutComment = commentMatch ? line.substring(0, commentMatch.index) : line;

            // 2. 匹配节
            const sectionInheritMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\]:\[)([^\]]+)(\])/);
            if (sectionInheritMatch) {
                let offset = sectionInheritMatch[0].indexOf('[');
                decorationsMap.get('sectionBracket')!.push(new vscode.Range(i, offset, i, offset + 1));
                offset++;
                decorationsMap.get('sectionContent')!.push(new vscode.Range(i, offset, i, offset + sectionInheritMatch[2].length));
                offset += sectionInheritMatch[2].length;
                decorationsMap.get('sectionBracket')!.push(new vscode.Range(i, offset, i, offset + 3));
                offset += 3;
                decorationsMap.get('sectionInherit')!.push(new vscode.Range(i, offset, i, offset + sectionInheritMatch[4].length));
                offset += sectionInheritMatch[4].length;
                decorationsMap.get('sectionBracket')!.push(new vscode.Range(i, offset, i, offset + 1));
                continue;
            }

            const sectionSimpleMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\])/);
            if(sectionSimpleMatch){
                let offset = sectionSimpleMatch[0].indexOf('[');
                decorationsMap.get('sectionBracket')!.push(new vscode.Range(i, offset, i, offset + 1));
                offset++;
                decorationsMap.get('sectionContent')!.push(new vscode.Range(i, offset, i, offset + sectionSimpleMatch[2].length));
                offset += sectionSimpleMatch[2].length;
                decorationsMap.get('sectionBracket')!.push(new vscode.Range(i, offset, i, offset + 1));
                continue;
            }

            // 3. 匹配键值对
            const kvMatch = lineWithoutComment.match(/^(\s*[^\s=]+(?:\.[^\s=]+)*)\s*(=)\s*(.*)/);
            if(kvMatch) {
                const keyFull = kvMatch[1];
                const keyParts = keyFull.trim().split('.');
                let keyOffset = lineWithoutComment.indexOf(keyParts[0]);
                keyParts.forEach((part, index) => {
                    const partIndex = keyFull.indexOf(part, keyOffset - lineWithoutComment.indexOf(keyFull));
                    if(partIndex !== -1) {
                         const styleKey = `keyPart${Math.min(index + 1, 3)}`;
                         decorationsMap.get(styleKey)!.push(new vscode.Range(i, partIndex, i, partIndex + part.length));
                         keyOffset = partIndex + part.length;
                    }
                });

                const operator = kvMatch[2];
                const opOffset = lineWithoutComment.indexOf(operator, keyOffset);
                decorationsMap.get('operator')!.push(new vscode.Range(i, opOffset, i, opOffset + operator.length));

                const valuePart = kvMatch[3];
                const valueOffset = lineWithoutComment.indexOf(valuePart, opOffset);
                if (valuePart.trim().length > 0) {
                     decorationsMap.get('value')!.push(new vscode.Range(i, valueOffset, i, valueOffset + valuePart.length));
                }
               
                const stringRegex = /"[^"]*"/g;
                const commaRegex = /,/g;
                let match;

                while((match = stringRegex.exec(valuePart)) !== null){
                    decorationsMap.get('valueString')!.push(new vscode.Range(i, valueOffset + match.index, i, valueOffset + match.index + match[0].length));
                }
                 while((match = commaRegex.exec(valuePart)) !== null){
                    decorationsMap.get('valueComma')!.push(new vscode.Range(i, valueOffset + match.index, i, valueOffset + match.index + 1));
                }
            }
        }

        // 应用所有装饰器
        this.decorationTypes.forEach((type, key) => {
            const ranges = decorationsMap.get(key) || [];
            editor.setDecorations(type, ranges);
        });
    }

    public dispose() {
        this.decorationTypes.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
    }
}