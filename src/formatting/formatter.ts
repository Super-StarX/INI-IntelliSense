import * as vscode from 'vscode';
import { localize } from '../i18n';

/**
 * 注册格式化相关的命令。
 */
export function registerFormattingCommands() {
    vscode.commands.registerCommand('ra2-ini-intellisense.format.document', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'ra2-ini') {
            const document = editor.document;
            const lastLine = document.lineAt(document.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character);
            await formatRange(editor, fullRange);
        }
    });

    vscode.commands.registerCommand('ra2-ini-intellisense.format.selection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'ra2-ini') {
            const range = editor.selection.isEmpty 
                ? editor.document.lineAt(editor.selection.active.line).range 
                : editor.selection;
            await formatRange(editor, range);
        }
    });
}

/**
 * 格式化指定编辑器的指定范围。
 * @param editor 文本编辑器实例
 * @param range 要格式化的范围
 */
async function formatRange(editor: vscode.TextEditor, range: vscode.Range) {
    const document = editor.document;
    const edit = new vscode.WorkspaceEdit();
    const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');

    const startLine = range.start.line;
    // 确保 endLine 不会超出文档范围
    const endLine = Math.min(range.end.line, document.lineCount - 1);

    for (let i = startLine; i <= endLine; i++) {
        const line = document.lineAt(i);
        // 如果是一个跨多行的选区，我们只格式化完全包含在选区内的行
        if (!range.isSingleLine && !range.contains(line.range)) {
            continue;
        }
        const newText = formatLine(line.text, config);
        if (newText !== line.text) {
            edit.replace(document.uri, line.range, newText);
        }
    }

    await vscode.workspace.applyEdit(edit);
}

/**
 * 格式化单行文本，采用统一的分解-重组策略。
 * @param text 行文本
 * @param config 配置对象
 * @returns 格式化后的行文本
 */
function formatLine(text: string, config: vscode.WorkspaceConfiguration): string {
    // 1. 将行分解为代码部分和注释部分
    const commentIndex = text.indexOf(';');
    const codePart = commentIndex === -1 ? text : text.substring(0, commentIndex);
    const commentPart = commentIndex === -1 ? null : text.substring(commentIndex);

    // 2. 格式化代码部分
    let formattedCode = codePart.trim();
    const equalsIndex = formattedCode.indexOf('=');
    // 确保它是一个键值对，而不是节或其他结构
    if (equalsIndex > 0 && !formattedCode.startsWith('[')) {
        const key = formattedCode.substring(0, equalsIndex).trim();
        const value = formattedCode.substring(equalsIndex + 1).trim();
        formattedCode = `${key}=${value}`;
    }

    // 3. 格式化注释部分
    let formattedComment = '';
    if (commentPart !== null) {
        const commentContent = commentPart.substring(1);
        if (config.get('spaceAfterComment') && commentContent.length > 0 && !commentContent.startsWith(' ')) {
            formattedComment = `; ${commentContent}`;
        } else {
            formattedComment = ';' + commentContent;
        }
    }

    // 4. 根据情况重组
    if (!formattedCode) {
        // 如果只有注释
        return formattedComment;
    }

    if (!formattedComment) {
        // 如果只有代码
        return formattedCode;
    }

    // 如果两者都有
    const spacesBefore = config.get<number | null>('spacesBeforeComment');
    const separator = typeof spacesBefore === 'number' ? ' '.repeat(spacesBefore) : ' ';
    
    return `${formattedCode}${separator}${formattedComment}`;
}