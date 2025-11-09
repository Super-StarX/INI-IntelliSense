import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let diagnostics: vscode.DiagnosticCollection;

/**
 * 扩展的主激活函数
 * @param context 扩展的上下文, 用于管理订阅和状态
 */
export async function activate(context: vscode.ExtensionContext) {
	const iniManager = new INIManager();
	const outlineProvider = new INIOutlineProvider(context, iniManager);
	const schemaManager = new SchemaManager();

	// 注册诊断集合
	diagnostics = vscode.languages.createDiagnosticCollection('ini');
	const iniValidator = new INIValidatorExt(diagnostics);
	// 初始化INIValidator, 包括状态栏、配置监听和首次使用引导
	await iniValidator.initialize(context);

	context.subscriptions.push(diagnostics);

	// 注册大纲视图
	context.subscriptions.push(vscode.window.createTreeView('ini-outline', { treeDataProvider: outlineProvider }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshOutline', () => outlineProvider.refresh()));


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
		outlineProvider.refresh();
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


	// 封装一个新的函数用于加载 Schema，使其可以在配置变更时重复调用
	async function loadSchemaFromConfiguration() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		// 1. 优先使用用户明确指定的 schema 路径
		let schemaPath = config.get<string | null>('schemaFilePath', null);
		const isExplicitPath = !!schemaPath; // 标记路径是否为用户明确指定

		// 2. 如果用户未指定, 则尝试从 INIValidator.exe 的路径推断
		if (!schemaPath) {
			const exePath = config.get<string | null>('exePath', null);
			if (exePath) {
				const exeDir = path.dirname(exePath);
				schemaPath = path.join(exeDir, 'INICodingCheck.ini');
			}
		}

		// 3. 如果最终找到了一个可用的路径, 则尝试加载
		if (schemaPath) {
			try {
				const schemaUri = vscode.Uri.file(schemaPath);
				const schemaContentBytes = await vscode.workspace.fs.readFile(schemaUri);
				const schemaContent = Buffer.from(schemaContentBytes).toString('utf-8');
				schemaManager.loadSchema(schemaContent);

				// 仅在明确设置了路径并成功加载时才提示, 避免默认加载时打扰用户
				if (isExplicitPath) {
					 vscode.window.showInformationMessage('自定义 INI 规则文件加载成功!');
				}
			} catch (error) {
				schemaManager.clearSchema();
				// 仅当用户明确设置了路径但加载失败时, 才显示错误信息
				if (isExplicitPath) {
					vscode.window.showErrorMessage(`加载指定的 INI 规则文件失败: ${schemaPath}。`);
				}
			}
		} else {
			schemaManager.clearSchema(); // 如果两个路径都没有, 确保清空
		}
	}

	// 首次激活时加载一次
	await loadSchemaFromConfiguration();

	// 监听配置变更，当用户修改 schema 文件路径或 IV 路径时自动重新加载
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') || e.affectsConfiguration('ra2-ini-intellisense.exePath')) {
			await loadSchemaFromConfiguration();
		}
	}));


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
			async provideCompletionItems(document, position, token, context) {
				const line = document.lineAt(position.line);
				const equalsIndex = line.text.indexOf('=');
				const isKeyCompletion = equalsIndex === -1 || position.character <= equalsIndex;
		
				if (isKeyCompletion) {
					// --- 键补全逻辑 ---
					// 查找光标所在的节
					let currentSectionName: string | null = null;
					for (let i = position.line; i >= 0; i--) {
						const lineText = document.lineAt(i).text.trim();
						const match = lineText.match(/^\s*\[([^\]:]+)/);
						if (match) {
							currentSectionName = match[1].trim();
							break;
						}
					}
			
					if (!currentSectionName) return [];
			
					// 查找该节所属的注册表类型
					const registryName = iniManager.findRegistryForSection(currentSectionName);
					let keys = new Map<string, string>();
			
					if (registryName) {
						const typeName = schemaManager.getTypeForRegistry(registryName);
						if (typeName) keys = schemaManager.getAllKeysForType(typeName);
					} else {
						// 如果不是注册表类型, 则可能是全局节, 如 [General]
						keys = schemaManager.getAllKeysForType(currentSectionName);
					}
			
					if (keys.size === 0) return [];
			
					// 创建补全项, 并包装在 CompletionList 中以禁用默认补全
					return new vscode.CompletionList(
						Array.from(keys.entries()).map(([key, valueType]) => {
							const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
							item.detail = `(${valueType})`;
							return item;
						}),
						false // false 表示我们的列表是完整的
					);
				} else {
					// --- 值补全逻辑 ---
					const suggestions = new Map<string, vscode.CompletionItem>();

					// 1. 添加所有节名 (IDs) 作为候选
					iniManager.getAllSectionNames().forEach(name => {
						if (!suggestions.has(name)) {
							suggestions.set(name, new vscode.CompletionItem(name, vscode.CompletionItemKind.Module));
						}
					});

					// 2. 添加所有出现过的值作为候选
					iniManager.getAllValues().forEach(value => {
						if (!suggestions.has(value)) {
							const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
							// 对纯数字和布尔值进行特殊处理
							if (/^-?\d+(\.\d+)?$/.test(value)) {
								item.kind = vscode.CompletionItemKind.Constant;
							} else if (['true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
								item.kind = vscode.CompletionItemKind.Keyword;
							}
							suggestions.set(value, item);
						}
					});

					// 返回包装在 CompletionList 中的建议项
					return new vscode.CompletionList(Array.from(suggestions.values()), false);
				}
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