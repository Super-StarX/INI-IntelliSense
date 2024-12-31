import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';

export function activate(context: vscode.ExtensionContext) {
	const iniManager = new INIManager();

	// 获取插件根目录
	const extensionRoot = __dirname;
	const iniConfigPath = path.join(extensionRoot, 'data', 'INIConfigCheck.ini');

	// 检查字典文件是否存在
	const fs = require('fs');
	if (!fs.existsSync(iniConfigPath)) {
		vscode.window.showErrorMessage(`Dictionary file not found: ${iniConfigPath}`);
		return;
	}

	// 加载字典文件
	try {
		iniManager.loadFile(iniConfigPath);
		vscode.window.showInformationMessage('INI Helper Plugin Activated Successfully!');
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to load INIConfigCheck.ini: ${error}`);
		return;
	}

    // 注册诊断集合
    const diagnostics = vscode.languages.createDiagnosticCollection('ini');
    context.subscriptions.push(diagnostics);

    // 更新诊断
    const updateDiagnostics = (document: vscode.TextDocument) => {
        if (document.languageId !== 'ini') {
            return;
        }

        const problems: vscode.Diagnostic[] = [];
        const lines = document.getText().split(/\r?\n/);

        lines.forEach((line, index) => {
            // 检查等号左侧空格
            const equalsLeft = line.match(/(\s+)=/);
            if (equalsLeft) {
                const start = line.indexOf(equalsLeft[1]);
                problems.push(
                    new vscode.Diagnostic(
                        new vscode.Range(index, start, index, start + equalsLeft[0].length - 1),
                        'Avoid spaces around "="',
                        vscode.DiagnosticSeverity.Warning
                    )
                );
            }

            // 检查等号右侧空格
            const equalsRight = line.match(/=(\s+)/);
            if (equalsRight) {
                const start = line.indexOf(equalsRight[1]);
                problems.push(
                    new vscode.Diagnostic(
                        new vscode.Range(index, start, index, start + equalsRight[0].length - 1),
                        'Avoid spaces around "="',
                        vscode.DiagnosticSeverity.Warning
                    )
                );
            }

            // 检查行以空格开头
            if (/^\s+/.test(line)) {
                problems.push(
                    new vscode.Diagnostic(
                        new vscode.Range(index, 0, index, line.match(/^\s+/)![0].length),
                        'Line starts with unnecessary spaces',
                        vscode.DiagnosticSeverity.Warning
                    )
                );
            }

            // 检查注释前未空一格
            const commentLeftMatch = line.match(/(?<=\S);/);
            if (commentLeftMatch) {
                const start = line.indexOf(commentLeftMatch[0]);
                problems.push(
                    new vscode.Diagnostic(
                        new vscode.Range(index, start, index, start + line.match(/;.+/)![0].length),
                        'Missing space before the comment',
                        vscode.DiagnosticSeverity.Warning
                    )
                );
            }

			// 检查注释后未空一格
			const commentRightMatch = line.match(/;(?=\s)/);
			if (commentRightMatch) {
				const start = line.indexOf(commentRightMatch[0]);
				problems.push(
					new vscode.Diagnostic(
						new vscode.Range(index, start, index, start + line.match(/;.+/)![0].length),
						'Missing space before the comment',
						vscode.DiagnosticSeverity.Warning
					)
				);
			}
        });

        diagnostics.set(document.uri, problems);
    };

    // 监听文档修改事件
    vscode.workspace.onDidChangeTextDocument((event) => {
        updateDiagnostics(event.document);
    });

    // 监听打开文件事件
    vscode.workspace.onDidOpenTextDocument((document) => {
        updateDiagnostics(document);
    });

    // 初始调用
    vscode.workspace.textDocuments.forEach(updateDiagnostics);

	// 注册跳转功能
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider('ini', {
			provideDefinition(document, position, token) {
				const wordRange = document.getWordRangeAtPosition(position);
				if (!wordRange) { return null; }

				const word = document.getText(wordRange);

				// 在当前文件中查找 section
				const currentFileContent = document.getText();
				const currentSectionLine = iniManager.findSectionInContent(currentFileContent, word);
				if (currentSectionLine !== null) {
					return new vscode.Location(
						document.uri,
						new vscode.Position(currentSectionLine, 0)
					);
				}

				// 在其他已加载的文件中查找 section
				const found = iniManager.findSection(word);
				if (found) {
					const fileUri = vscode.Uri.file(found.file);

					// 计算目标 section 在目标文件中的行号
					const targetLine = iniManager.findSectionInContent(found.content, word);
					if (targetLine !== null) {
						return new vscode.Location(
							fileUri,
							new vscode.Position(targetLine, 0)
						);
					}
				}

				return null;
			}
		}),
		// 鼠标悬浮时显示节注释
		vscode.languages.registerHoverProvider({ language: 'ini' }, {
			provideHover(document, position) {
				const wordRange = document.getWordRangeAtPosition(position, /[^=\s]+/);
				if (!wordRange) { return null; }

				const word = document.getText(wordRange);

				const sectionComment = iniManager.findSection(word);
				if (sectionComment) {
					return new vscode.Hover(`${iniManager.getSectionComment(document.getText(), word)}`);
				}
				else {
					// 显示key在字典里的解释
				}
			}
		}),
		//输入预测功能
		vscode.languages.registerCompletionItemProvider('ini', {
			provideCompletionItems(document, position, token, context) {
				const suggestions: vscode.CompletionItem[] = [];
				iniManager.files.forEach((fileData) => {
					for (const [section, keys] of Object.entries(fileData.parsed || {})) {
						for (const key of Object.keys(keys || {})) {
							const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
							item.detail = `Key from section [${section}]`;
							suggestions.push(item);
						}
					}
				});
				return suggestions;
			}
		}),
		// 折叠功能
		vscode.languages.registerFoldingRangeProvider({ language: 'ini' }, {
			provideFoldingRanges(document, context, token) {
				const result = [];

				// 段
				const sectionRegex = /^\s*\[([^\]]+)\]/;
				// 键
				const keyRegex = /^\s*([^\[;=]+)\s*=/;

				let prevSecName = null;
				let prevSecLineStart = 0;
				let prevSecLineEnd = null;
				// 段下面最后的键所在的行号
				// (段只会折叠到其下面最后一个键所在行，后面的注释不会被折叠！)
				let lastKeyLine = null;

				for (let line = 0; line < document.lineCount; line++) {
					const { text } = document.lineAt(line);

					// 匹配段
					const secMatched = text.match(sectionRegex);
					if (secMatched) {

						// 先闭合上一个段
						if (prevSecName !== null) {
							lastKeyLine = line - 1; // **L自用新增，折叠两个段之间的所有内容
							prevSecLineEnd = lastKeyLine;
							const prevSecFoldingRange = new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region);
							result.push(prevSecFoldingRange);
						}

						// 记录下新段的信息
						prevSecName = secMatched[1];
						prevSecLineStart = line;
						continue;
					}

					// 匹配键（注意：键必须位于最近的段下面）
					const keyMatched = text.match(keyRegex);
					if ((prevSecName !== null) && keyMatched) {
						lastKeyLine = line;
						continue;
					}
				}

				// 记得：闭合最后一个段！
				if (prevSecName !== null) {
					prevSecLineEnd = document.lineCount - 1;
					const prevSecFoldingRange = new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region);
					result.push(prevSecFoldingRange);
				}

				return result;
			}
		})
	);
}
