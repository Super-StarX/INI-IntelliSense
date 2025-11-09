import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let diagnostics: vscode.DiagnosticCollection;

/**
 * 扩展的主激活函数
 * @param context 扩展的上下文, 用于管理订阅和状态
 */
export async function activate(context: vscode.ExtensionContext) {
	const iniManager = new INIManager();

	// 注册诊断集合
	diagnostics = vscode.languages.createDiagnosticCollection('ini');
	const iniValidator = new INIValidatorExt(diagnostics);
	// 初始化INIValidator, 包括状态栏、配置监听和首次使用引导
	await iniValidator.initialize(context);

	context.subscriptions.push(diagnostics);


	// 建立工作区INI文件索引
	async function indexWorkspaceFiles() {
		// 使用 findFiles API 查找工作区内所有的 .ini 文件
		const iniFiles = await vscode.workspace.findFiles('**/*.ini');
		
		iniManager.clear();

		for (const fileUri of iniFiles) {
			try {
				// 使用 VS Code 的文件系统 API 读取文件, 更安全
				const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
				const fileContent = Buffer.from(fileContentBytes).toString('utf8');
				iniManager.loadFile(fileUri.fsPath, fileContent);
			} catch (error) {
				console.error(`加载或解析INI文件失败: ${fileUri.fsPath}`, error);
			}
		}
		console.log(`INI IntelliSense: 已索引 ${iniManager.files.size} 个INI文件。`);
	}

	// 首次激活时立即索引
	await indexWorkspaceFiles();

	// 监听文件变化, 保持索引最新
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindex = (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在重新索引工作区...`);
		indexWorkspaceFiles();
	};

	watcher.onDidCreate(reindex);
	watcher.onDidDelete(reindex);
	watcher.onDidChange(reindex);


	// 获取插件根目录
	const extensionRoot = __dirname;
	const iniConfigPath = path.join(extensionRoot, 'data', 'INIConfigCheck.ini');

	// 检查字典文件是否存在
	const fs = require('fs');
	if (!fs.existsSync(iniConfigPath)) {
		vscode.window.showErrorMessage(`字典文件未找到: ${iniConfigPath}`);
		return;
	}

	// 加载字典文件
	try {
		iniManager.loadFile(iniConfigPath);
		vscode.window.showInformationMessage('INI 智能提示插件已成功激活!');
	} catch (error) {
		vscode.window.showErrorMessage(`加载 INIConfigCheck.ini 失败: ${error}`);
		return;
	}

    /**
     * 更新单个文档的诊断信息 (包括内置格式检查和外部校验)
     * @param document 需要更新诊断的文本文档
     */
    const updateDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== 'ini') {
            return;
        }

		// 自动校验功能可以在此触发, 但为避免过于频繁, 建议由用户手动触发
		// if (iniValidator.isReady()) {
		// 	await iniValidator.runValidation();
		// }

		// --- 内置的格式检查逻辑 (始终运行) ---
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
                        '请避免在 "=" 周围使用空格',
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
                        '请避免在 "=" 周围使用空格',
                        vscode.DiagnosticSeverity.Warning
                    )
                );
            }

            // 检查行以空格开头
			const leadingSpaceMatch = line.match(/^\s+/);
			if (leadingSpaceMatch) {
				problems.push(
					new vscode.Diagnostic(
						new vscode.Range(index, 0, index, leadingSpaceMatch[0].length),
						'行首存在不必要的空格',
						vscode.DiagnosticSeverity.Warning
					)
				);
			}

            // 检查注释前未空一格
			const commentLeftMatch = line.match(/(?<=\S);/);
			if (commentLeftMatch) {
				const fullCommentMatch = line.match(/;.*/); // 匹配分号及其后的所有内容
				if (fullCommentMatch) {
					const start = line.indexOf(fullCommentMatch[0]);
					problems.push(
						new vscode.Diagnostic(
							new vscode.Range(index, start, index, start + fullCommentMatch[0].length),
							'注释符号 ";" 前应有一个空格',
							vscode.DiagnosticSeverity.Warning
						)
					);
				}
			}

			// 检查注释后未空一格
			const commentRightMatch = line.match(/;(?=\s)/);
			if (commentRightMatch) {
				const fullCommentMatch = line.match(/;.*/); // 匹配分号及其后的所有内容
				if (fullCommentMatch) {
					const start = line.indexOf(fullCommentMatch[0]);
					problems.push(
						new vscode.Diagnostic(
							new vscode.Range(index, start, index, start + fullCommentMatch[0].length),
							// 注意: 此处的规则和上一条似乎重复, 您可能想调整逻辑或提示信息
							'注释符号 ";" 前应有一个空格',
							vscode.DiagnosticSeverity.Warning
						)
					);
				}
			}
        });
		
		// 仅更新由本插件（非IV）产生的诊断信息
		const existingDiagnostics = diagnostics.get(document.uri) || [];
		const externalDiagnostics = existingDiagnostics.filter(d => d.source === 'INI Validator');
        diagnostics.set(document.uri, [...externalDiagnostics, ...problems]);
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

	// 注册语言特性提供者
	context.subscriptions.push(
		// 跳转到定义
		vscode.languages.registerDefinitionProvider('ini', {
			async provideDefinition(document, position, token) {
				// 优化单词识别, 允许字母、数字、下划线、点、中横线
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) {
					return null;
				}
				const word = document.getText(wordRange);

				// 优先级 1: 在当前文件中查找
				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}

				// 优先级 2: 在工作区其他已索引文件中查找
				const locations: vscode.Location[] = [];
				const currentFilePath = document.uri.fsPath;
				for (const [filePath, data] of iniManager.files.entries()) {
					if (filePath === currentFilePath) {
						continue;
					}
					const line = iniManager.findSectionInContent(data.content, word);
					if (line !== null) {
						locations.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(line, 0)));
					}
				}

				if (locations.length === 1) {
					return locations[0];
				}
				if (locations.length > 1) {
					return locations;
				}

				vscode.window.showInformationMessage(`未找到节 '[${word}]' 的定义`);
				return null;
			}
		}),
		// 悬停提示
		vscode.languages.registerHoverProvider({ language: 'ini' }, {
			provideHover(document, position) {
				const wordRange = document.getWordRangeAtPosition(position, /[^=\s]+/);
				if (!wordRange) {
					return null;
				}

				const word = document.getText(wordRange);
				const sectionComment = iniManager.findSection(word);
				if (sectionComment) {
					return new vscode.Hover(`${iniManager.getSectionComment(document.getText(), word)}`);
				}
			}
		}),
		// 自动补全
		vscode.languages.registerCompletionItemProvider('ini', {
			provideCompletionItems(document, position, token, context) {
				const suggestions: vscode.CompletionItem[] = [];
				iniManager.files.forEach((fileData) => {
					for (const [section, keys] of Object.entries(fileData.parsed || {})) {
						for (const key of Object.keys(keys || {})) {
							const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
							item.detail = `来自 [${section}] 节`;
							suggestions.push(item);
						}
					}
				});
				return suggestions;
			}
		}),
		// 代码折叠
		vscode.languages.registerFoldingRangeProvider({ language: 'ini' }, {
			provideFoldingRanges(document, context, token) {
				const result = [];
				const sectionRegex = /^\s*\[([^\]]+)\]/;
				const keyRegex = /^\s*([^\[;=]+)\s*=/;
				let prevSecName = null;
				let prevSecLineStart = 0;
				let prevSecLineEnd = null;
				let lastKeyLine = null;

				for (let line = 0; line < document.lineCount; line++) {
					const { text } = document.lineAt(line);
					const secMatched = text.match(sectionRegex);
					if (secMatched) {
						if (prevSecName !== null) {
							lastKeyLine = line - 1;
							prevSecLineEnd = lastKeyLine;
							result.push(new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region));
						}
						prevSecName = secMatched[1];
						prevSecLineStart = line;
						continue;
					}
					const keyMatched = text.match(keyRegex);
					if ((prevSecName !== null) && keyMatched) {
						lastKeyLine = line;
						continue;
					}
				}

				if (prevSecName !== null) {
					prevSecLineEnd = document.lineCount - 1;
					result.push(new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region));
				}
				return result;
			}
		}),
	);
}

/**
 * 扩展的停用函数, 用于清理资源
 */
export function deactivate() {
	// 目前无需清理
}