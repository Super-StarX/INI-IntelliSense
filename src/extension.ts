import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let diagnostics: vscode.DiagnosticCollection;


export async function activate(context: vscode.ExtensionContext) {
	const iniManager = new INIManager();

	// 注册诊断集合
	diagnostics = vscode.languages.createDiagnosticCollection('ini');
	const iniValidator = new INIValidatorExt(diagnostics);

	//读取IniValidator的路径
	iniValidator.updateIniValidatorPath();
	//注册快速打开设置项的命令
	const openSettingsCommand = iniValidator.registerCommand();
	context.subscriptions.push(openSettingsCommand);
	context.subscriptions.push(diagnostics);


	// 建立工作区INI文件索引
	async function indexWorkspaceFiles() {
		// 使用 findFiles API 查找工作区内所有的 .ini 文件
		const iniFiles = await vscode.workspace.findFiles('**/*.ini');
		
		iniManager.clear();

		for (const fileUri of iniFiles) {
			try {
				// 使用 VS Code 的文件系统 API 读取文件,更安全
				const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
				const fileContent = Buffer.from(fileContentBytes).toString('utf8');
				iniManager.loadFile(fileUri.fsPath, fileContent);
			} catch (error) {
				console.error(`Failed to load or parse INI file: ${fileUri.fsPath}`, error);
			}
		}
		console.log(`INI IntelliSense: Indexed ${iniManager.files.size} INI files.`);
	}

	// 首次激活时立即索引
	await indexWorkspaceFiles();

	// 监听文件变化,保持索引最新
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindex = (uri: vscode.Uri) => {
		console.log(`INI file changed: ${uri.fsPath}, re-indexing workspace...`);
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

    context.subscriptions.push(diagnostics);

    // 更新诊断
    const updateDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== 'ini') {
            return;
        }

		const fileSection = iniManager.findSection("Files");
		const content = iniManager.parseDocument(fileSection?.content ?? "") as any;
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if(!workspaceFolders){
			throw new Error("No workspace folder found.");
		}
		const rulesFile = path.join(workspaceFolders[0].uri.fsPath, content.Files.rules);
		// const artFile = content.Files.art;
		await iniValidator.callIniValidator([rulesFile]);

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
			async provideDefinition(document, position, token) {
				// 优化单词识别,允许字母、数字、下划线、点、中横线
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
						continue; // 跳过当前文件
					}

					const line = iniManager.findSectionInContent(data.content, word);
					if (line !== null) {
						locations.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(line, 0)));
					}
				}

				// 处理查找结果
				if (locations.length === 1) {
					return locations[0]; // 只有一个结果,直接跳转
				}
				if (locations.length > 1) {
					return locations; // 多个结果,VS Code会弹窗让用户选择
				}

				// 找不到任何定义,给出明确反馈
				vscode.window.showInformationMessage(`Definition not found for '[${word}]'`);
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
		}),
	);
}






// This method is called when your extension is deactivated
export function deactivate() {
	
 }