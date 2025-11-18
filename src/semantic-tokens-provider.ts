import * as vscode from 'vscode';

// 定义语义化令牌的类型
// 这个列表的顺序必须与 package.json 中定义的 `legend.tokenTypes` 完全一致
const tokenTypes = [
    'comment',          // 注释
    'sectionBracket',   // 节的方括号
    'sectionContent',   // 节的内容
    'sectionInherit',   // 节的继承部分
    'keyPart1',         // 键的第一部分
    'keyPart2',         // 键的第二部分
    'keyPart3',         // 键的第三部分及之后
    'operator',         // 等号
    'value',            // 值的默认
    'valueComma',       // 值之间的逗号
    'valueString'       // 被引号包裹的值
];
const tokenModifiers: string[] = []; // 当前未使用修饰符
export const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

/**
 * 为 INI 文件提供高性能的语义化高亮。
 * 这个类实现了全量和增量两种更新方式，以达到最佳性能。
 */
export class IniSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.DocumentRangeSemanticTokensProvider {
    
    // 创建一个 Map 用于快速从类型名查找其在 legend 中的索引，提高效率
    private tokenTypeMap = new Map<string, number>(tokenTypes.map((t, i) => [t, i]));

    /**
     * VS Code 在打开文件或需要全量更新时调用此方法。
     * @param document 需要进行高亮的文本文档
     * @param token 一个取消令牌
     */
    public async provideDocumentSemanticTokens(
        document: vscode.TextDocument, 
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        
        const builder = new vscode.SemanticTokensBuilder(legend);
        
        // 逐行解析文档
        for (let i = 0; i < document.lineCount; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const line = document.lineAt(i);
            this.parseLine(line, builder);
        }
        
        return builder.build();
    }

    /**
     * VS Code 在文档编辑时调用此方法，只请求变更范围内的令牌。
     * 这是实现高性能实时高亮的关键。
     * @param document 被编辑的文本文档
     * @param range 发生变更的行范围
     * @param token 一个取消令牌
     */
    public async provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        
        // 循环不再是整个文档，而是 VS Code 提供的、发生变更的范围
        for (let i = range.start.line; i <= range.end.line; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const line = document.lineAt(i);
            this.parseLine(line, builder);
        }
        
        return builder.build();
    }
    
    /**
     * 一个辅助方法，用于将解析出的令牌推送到构建器中。
     * @param builder SemanticTokensBuilder 实例
     * @param line 行号
     * @param start 起始字符
     * @param length 长度
     * @param tokenTypeKey 令牌类型的字符串键
     */
    private pushToken(builder: vscode.SemanticTokensBuilder, line: number, start: number, length: number, tokenTypeKey: string) {
        const tokenTypeIndex = this.tokenTypeMap.get(tokenTypeKey);
        if (tokenTypeIndex !== undefined) {
            builder.push(line, start, length, tokenTypeIndex, 0);
        }
    }

    /**
     * 解析单行文本，并根据其语法结构生成对应的语义化令牌。
     * 这个方法被全量更新和增量更新两种模式共用。
     * @param line 当前要解析的行
     * @param builder SemanticTokensBuilder 实例
     */
    private parseLine(line: vscode.TextLine, builder: vscode.SemanticTokensBuilder): void {
        const lineText = line.text;
        const lineNumber = line.lineNumber;

        // 优先级 1: 注释
        // 注释拥有最高优先级，先将其从后续的解析逻辑中剥离
        const commentIndex = lineText.indexOf(';');
        let lineWithoutComment = lineText;
        if (commentIndex !== -1) {
            this.pushToken(builder, lineNumber, commentIndex, lineText.length - commentIndex, 'comment');
            lineWithoutComment = lineText.substring(0, commentIndex);
        }

        // 优先级 2: 带继承的节，例如 [Section]:[Base]
        // 这个规则比简单节更具体，因此需要优先匹配
        const inheritMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\]:\[)([^\]]+)(\])/);
        if (inheritMatch) {
            let offset = lineWithoutComment.indexOf('[');
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            offset += 1;
            this.pushToken(builder, lineNumber, offset, inheritMatch[2].length, 'sectionContent');
            offset += inheritMatch[2].length;
            this.pushToken(builder, lineNumber, offset, 3, 'sectionInherit'); // ']:['
            offset += 3;
            this.pushToken(builder, lineNumber, offset, inheritMatch[4].length, 'sectionInherit');
            offset += inheritMatch[4].length;
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            return; // 行已解析完毕，无需继续
        }

        // 优先级 3: 简单节，例如 [Section]
        const simpleMatch = lineWithoutComment.match(/^\s*(\[)([^\]:]+)(\])/);
        if (simpleMatch) {
            let offset = lineWithoutComment.indexOf('[');
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            offset += 1;
            this.pushToken(builder, lineNumber, offset, simpleMatch[2].length, 'sectionContent');
            offset += simpleMatch[2].length;
            this.pushToken(builder, lineNumber, offset, 1, 'sectionBracket');
            return; // 行已解析完毕
        }

        // 优先级 4: 键值对，例如 Key.Part1=Value1,Value2
        const kvMatch = lineWithoutComment.match(/^(\s*[^\s=]+(?:\.[^\s=]+)*)\s*(=)\s*(.*)/);
        if (kvMatch) {
            const keyFull = kvMatch[1];
            const operator = kvMatch[2];
            const valuePart = kvMatch[3];

            // 解析键 (Key)，支持多级部分
            const keyParts = keyFull.trim().split('.');
            let keyOffset = lineWithoutComment.indexOf(keyParts[0]);
            keyParts.forEach((part, index) => {
                const styleKey = `keyPart${Math.min(index + 1, 3)}`;
                this.pushToken(builder, lineNumber, keyOffset, part.length, styleKey);
                keyOffset += part.length + 1; // +1 for the dot separator
            });

            // 解析操作符 (Operator)
            const opOffset = lineWithoutComment.indexOf(operator, keyFull.length);
            this.pushToken(builder, lineNumber, opOffset, operator.length, 'operator');

            // 解析值 (Value)
            const valueOffset = lineWithoutComment.indexOf(valuePart, opOffset);
            if (valuePart.trim().length > 0) {
                // 首先为整个值部分应用默认的 'value' 类型
                this.pushToken(builder, lineNumber, valueOffset, valuePart.length, 'value');

                // 接着，在值内部查找更具体的类型并进行覆盖
                const stringRegex = /"[^"]*"/g;
                const commaRegex = /,/g;
                let match;
                // 查找所有被引号包裹的字符串
                while ((match = stringRegex.exec(valuePart)) !== null) {
                    this.pushToken(builder, lineNumber, valueOffset + match.index, match[0].length, 'valueString');
                }
                // 查找所有逗号
                while ((match = commaRegex.exec(valuePart)) !== null) {
                    this.pushToken(builder, lineNumber, valueOffset + match.index, 1, 'valueComma');
                }
            }
        }
    }
}