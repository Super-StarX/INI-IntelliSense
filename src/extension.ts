import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager, ValueTypeCategory } from './schema-manager';
import { DynamicThemeManager } from './dynamic-theme';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let diagnostics: vscode.DiagnosticCollection;
const LANGUAGE_ID = 'ra2-ini';

/**
 * 扩展的主激活函数
 * @param context 扩展的上下文, 用于管理订阅和状态
 */
export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("INI IntelliSense");
	const iniManager = new INIManager();
	const outlineProvider = new INIOutlineProvider(context, iniManager);
	const schemaManager = new SchemaManager();
	iniManager.setSchemaManager(schemaManager); // 将 schemaManager 实例注入 iniManager

	const selector = { language: LANGUAGE_ID };

	// 动态主题管理器
	const themeManager = new DynamicThemeManager();
	context.subscriptions.push(themeManager);

	// 创建 Schema 状态栏
	const schemaStatusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	schemaStatusbar.command = 'ra2-ini-intellisense.configureSchemaPath';
	context.subscriptions.push(schemaStatusbar);

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
		
		await iniManager.indexFiles(iniFiles);

		console.log(`INI IntelliSense: 已索引 ${iniManager.files.size} 个INI文件。`);
		outlineProvider.refresh();
	}

	function updateSchemaStatus(loadedPath: string | null) {
		if (loadedPath) {
			schemaStatusbar.text = `$(check) INI Schema`;
			schemaStatusbar.tooltip = `INI Schema Loaded: ${loadedPath}\nClick to change the schema file.`;
			schemaStatusbar.backgroundColor = undefined;
		} else {
			schemaStatusbar.text = `$(warning) INI Schema`;
			schemaStatusbar.tooltip = `INI Schema not loaded. Click to select your INICodingCheck.ini file.`;
			schemaStatusbar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		schemaStatusbar.show();
	}

	// 封装一个新的函数用于加载 Schema，使其可以在配置变更时重复调用
	async function loadSchemaFromConfiguration() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		let loadedPath: string | null = null;
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
				loadedPath = schemaPath;

				if (isExplicitPath) {
					 vscode.window.showInformationMessage(`自定义 INI 规则文件加载成功: ${schemaPath}`);
				}
			} catch (error) {
				schemaManager.clearSchema();
				if (isExplicitPath) {
					vscode.window.showErrorMessage(`加载指定的 INI 规则文件失败: ${schemaPath}。`);
				}
			}
		} else {
			schemaManager.clearSchema(); // 如果两个路径都没有, 确保清空
		}
		
		updateSchemaStatus(loadedPath);
		// Schema 加载后, 重新索引文件以建立正确的 ID -> 注册表映射
		await indexWorkspaceFiles();
	}
	
	// 注册设置 Schema 路径的命令
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.configureSchemaPath', async () => {
		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: 'Select INICodingCheck.ini',
			filters: { 'INI Files': ['ini'] }
		};
		const fileUri = await vscode.window.showOpenDialog(options);
		if (fileUri && fileUri[0]) {
			await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', fileUri[0].fsPath, vscode.ConfigurationTarget.Global);
			// The onDidChangeConfiguration listener will handle the reload
		}
	}));


	// 首次激活时加载一次
	await loadSchemaFromConfiguration();

	// 监听配置变更，动态处理功能
	let codeLensProvider: vscode.Disposable | undefined;
	function updateCodeLensProvider() {
		const isEnabled = vscode.workspace.getConfiguration('ra2-ini-intellisense').get('codeLens.enabled');
		if (isEnabled) {
			if (!codeLensProvider) {
				codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
					provideCodeLenses(document, token) {
						const codeLenses: vscode.CodeLens[] = [];
						for (let i = 0; i < document.lineCount; i++) {
							const line = document.lineAt(i);
							const sectionMatch = line.text.match(/^\s*\[([^\]:]+)\]/);
							if (sectionMatch) {
								const sectionName = sectionMatch[1];
								const references = iniManager.findReferences(sectionName);
								const range = new vscode.Range(i, 0, i, line.text.length);
								
								let title: string;
								if (references.length > 0) {
									title = `被引用 ${references.length} 次`;
								} else {
									title = '0 次引用 (可能未使用)';
								}
		
								codeLenses.push(new vscode.CodeLens(range, {
									title: title,
									command: 'editor.action.findReferences', // 点击时触发查找引用
									arguments: [document.uri, new vscode.Position(i, 1)]
								}));
							}
						}
						return codeLenses;
					}
				});
				context.subscriptions.push(codeLensProvider);
			}
		} else {
			codeLensProvider?.dispose();
			codeLensProvider = undefined;
		}
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') || e.affectsConfiguration('ra2-ini-intellisense.exePath')) {
			await loadSchemaFromConfiguration();
			// Schema 变更后, 重新校验所有打开的文档
			vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc, true));
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.codeLens.enabled')) {
			updateCodeLensProvider();
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.diagnostics')) {
			vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc, true));
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.colors')) {
			themeManager.reloadDecorations();
		}
	}));
	updateCodeLensProvider();

	// 监听文件变化, 保持索引最新
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindex = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在重新索引工作区...`);
		await indexWorkspaceFiles();
		// 文件变更可能影响校验结果, 重新校验所有打开的文档
		vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));
	};

	watcher.onDidCreate(reindex);
	watcher.onDidDelete(reindex);
	watcher.onDidChange(reindex);

	// 注册调试命令
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showDebugInfo', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('请先打开一个 INI 文件再运行此命令。');
			return;
		}

		const position = editor.selection.active;
		const document = editor.document;
		
		outputChannel.clear();
		outputChannel.appendLine("--- INI 智能感知调试信息 ---\n");

		// 增强日志: 打印 Schema 加载情况
		const idListRegistryNames = schemaManager.getIdListRegistryNames();
		if (idListRegistryNames.size > 0) {
			outputChannel.appendLine(`✅ Schema 加载完毕: 共找到 ${schemaManager.getRegistryNames().size} 个注册表。`);
			outputChannel.appendLine(`✅ 已识别出 ${idListRegistryNames.size} 个用于索引的ID列表注册表:`);
			outputChannel.appendLine(`   ${Array.from(idListRegistryNames).join(', ')}`);
		} else {
			outputChannel.appendLine(`❌ 警告: 未从Schema中识别出任何ID列表注册表，类型推断将失败。`);
		}
		outputChannel.appendLine(`✅ 索引完毕: 在所有文件中，共找到 ${iniManager.getRegistryMapSize()} 个唯一的已注册节ID。\n`);

		outputChannel.appendLine(`--- 上下文信息 ---`);
		outputChannel.appendLine(`文件: ${document.uri.fsPath}`);
		outputChannel.appendLine(`光标位置: 行 ${position.line + 1}, 字符 ${position.character + 1}\n`);

		// 查找当前节
		let currentSectionName: string | null = null;
		for (let i = position.line; i >= 0; i--) {
			const lineText = document.lineAt(i).text.trim();
			const match = lineText.match(/^\s*\[([^\]:]+)/);
			if (match) {
				currentSectionName = match[1].trim();
				break;
			}
		}

		if (!currentSectionName) {
			outputChannel.appendLine("错误: 光标不在一个有效的节内。");
			outputChannel.show();
			return;
		}
		
		outputChannel.appendLine(`✅ 当前节: [${currentSectionName}]`);

		// 查找类型
		const registryName = iniManager.findRegistryForSection(currentSectionName);
		let typeName: string | undefined;

		if (registryName) {
			outputChannel.appendLine(`✅ 在注册表中找到: [${registryName}]`);
			typeName = schemaManager.getTypeForRegistry(registryName);
			if (typeName) {
				outputChannel.appendLine(`✅ 推断类型为: '${typeName}'`);
			} else {
				outputChannel.appendLine(`❌ 错误: 注册表 [${registryName}] 未在Schema中映射到一个已知类型。`);
			}
		} else {
			outputChannel.appendLine(`ℹ️ 信息: 未在任何注册表中找到该节，假定其为全局或字面类型。`);
			typeName = currentSectionName;
		}
		
		// 增强日志: 打印类型继承链和键信息
		if (typeName) {
			const debugLines = schemaManager.getDebugInfoForType(typeName);
			outputChannel.appendLine("\n--- 类型继承与键值分析 ---");
			debugLines.forEach(line => outputChannel.appendLine(line));

			const allKeys = schemaManager.getAllKeysForType(typeName);
			if (allKeys.size > 0) {
				outputChannel.appendLine(`\n✅ 总可用键 (包含继承): ${allKeys.size} 个`);
			} else {
				outputChannel.appendLine(`\n❌ 警告: 在分析继承链后，未找到类型 '${typeName}' 的任何键。`);
			}

			// 新增: 分析当前行的键值类型
			outputChannel.appendLine("\n--- 当前行分析 ---");
			const lineText = document.lineAt(position.line).text;
			outputChannel.appendLine(`当前行文本: "${lineText.trim()}"`);
			const equalsIndex = lineText.indexOf('=');
			if (equalsIndex !== -1) {
				const currentKey = lineText.substring(0, equalsIndex).trim();
				outputChannel.appendLine(`识别出的键: '${currentKey}'`);

				let valueType: string | undefined;
				// 不区分大小写查找
				for (const [key, type] of allKeys.entries()) {
					if (key.toLowerCase() === currentKey.toLowerCase()) {
						valueType = type;
						break;
					}
				}

				if (valueType) {
					outputChannel.appendLine(`✅ 在类型 '${typeName}' 中找到该键, 其值类型为: '${valueType}'`);
				} else {
					outputChannel.appendLine(`❌ 警告: 在类型 '${typeName}' 及其父类中未找到键 '${currentKey}'。`);
				}
			} else {
				outputChannel.appendLine("当前行不是一个有效的键值对。");
			}

		} else {
			outputChannel.appendLine(`\n❌ 错误: 无法确定要分析的类型。`);
		}
		
		outputChannel.show();
	}));


    /**
     * 更新单个文档的诊断信息 (包括内置格式检查和外部校验)
     * @param document 需要更新诊断的文本文档
	 * @param forceClear 是否强制清除旧的诊断信息
     */
    const updateDiagnostics = async (document: vscode.TextDocument, forceClear: boolean = false) => {
        if (document.languageId !== LANGUAGE_ID) {
            return;
        }

		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
		const checkSpaceBeforeEquals = config.get<boolean>('spaceBeforeEquals', true);
		const checkSpaceAfterEquals = config.get<boolean>('spaceAfterEquals', true);
		const checkLeadingWhitespace = config.get<boolean>('leadingWhitespace', true);
		const spacesBeforeComment = config.get<number | null>('spacesBeforeComment', 1);
		const checkSpaceAfterComment = config.get<boolean>('spaceAfterComment', true);

		const problems: vscode.Diagnostic[] = [];
        const lines = document.getText().split(/\r?\n/);

		let currentSectionName: string | null = null;
		let currentTypeName: string | null = null;
		let currentKeys: Map<string, string> | null = null;
		
        lines.forEach((lineText, index) => {
			// 1. 检查是否进入了新的节
			const sectionMatch = lineText.match(/^\s*\[([^\]:]+)/);
			if (sectionMatch) {
				currentSectionName = sectionMatch[1].trim();
				// 优先将节名本身视为类型。如果 schema 中不存在该类型定义，再尝试通过注册表推断。
				currentTypeName = currentSectionName;
				if (!schemaManager.getAllKeysForType(currentTypeName).size) {
					const registryName = iniManager.findRegistryForSection(currentSectionName);
					currentTypeName = registryName ? schemaManager.getTypeForRegistry(registryName) ?? currentSectionName : currentSectionName;
				}
				currentKeys = currentTypeName ? schemaManager.getAllKeysForType(currentTypeName) : null;
			}
			
			// 2. 内置格式检查
			// 检查等号左侧空格
			if (checkSpaceBeforeEquals) {
				const equalsLeft = lineText.match(/(\s+)=/);
				if (equalsLeft) {
					const start = lineText.indexOf(equalsLeft[0]);
					problems.push(new vscode.Diagnostic(new vscode.Range(index, start, index, start + equalsLeft[1].length), '请避免在 "=" 左侧使用空格', vscode.DiagnosticSeverity.Warning));
				}
			}
			// 检查等号右侧空格
			if (checkSpaceAfterEquals) {
				const equalsRight = lineText.match(/=(\s+)/);
				if (equalsRight) {
					const start = lineText.indexOf(equalsRight[0]) + 1;
					problems.push(new vscode.Diagnostic(new vscode.Range(index, start, index, start + equalsRight[1].length), '请避免在 "=" 右侧使用空格', vscode.DiagnosticSeverity.Warning));
				}
			}
			// 检查行以空格开头
			if (checkLeadingWhitespace) {
				const leadingSpaceMatch = lineText.match(/^\s+/);
				if (leadingSpaceMatch && lineText.trim().length > 0) { // 忽略空行
					problems.push(new vscode.Diagnostic(new vscode.Range(index, 0, index, leadingSpaceMatch[0].length), '行首存在不必要的空格', vscode.DiagnosticSeverity.Warning));
				}
			}
			// 检查注释前空格数量
			if (spacesBeforeComment !== null) {
				const commentIndex = lineText.indexOf(';');
				if (commentIndex > 0 && lineText.substring(0, commentIndex).trim().length > 0) {
					const precedingText = lineText.substring(0, commentIndex);
					const trailingSpacesMatch = precedingText.match(/(\s+)$/);
					const numSpaces = trailingSpacesMatch ? trailingSpacesMatch[1].length : 0;
					if (numSpaces !== spacesBeforeComment) {
						problems.push(new vscode.Diagnostic(new vscode.Range(index, commentIndex - numSpaces, index, commentIndex), `注释符号 ";" 前应有 ${spacesBeforeComment} 个空格`, vscode.DiagnosticSeverity.Warning));
					}
				}
			}
			// 检查注释后缺少空格
			if (checkSpaceAfterComment) {
				const commentRightMatch = lineText.match(/;\S/);
				if (commentRightMatch) {
					const start = lineText.indexOf(commentRightMatch[0]);
					problems.push(new vscode.Diagnostic(new vscode.Range(index, start, index, start + 2), '注释符号 ";" 后应有一个空格', vscode.DiagnosticSeverity.Warning));
				}
			}

			// 3. 基于 Schema 的键值对验证
			const kvMatch = lineText.match(/^\s*([^;=\s][^=]*?)\s*=\s*(.*)/);
			if (kvMatch && currentKeys) {
				const key = kvMatch[1].trim();
				const valueString = kvMatch[2].split(';')[0].trim();
				
				let valueType: string | undefined;
				for (const [k, v] of currentKeys.entries()) {
					if (k.toLowerCase() === key.toLowerCase()) {
						valueType = v;
						break;
					}
				}

				if (valueType) {
					const errorMessage = validateValueByType(valueString, valueType, schemaManager, iniManager);
					if (errorMessage) {
						const valueStartIndex = lineText.indexOf(valueString, lineText.indexOf('=') + 1);
						const range = new vscode.Range(index, valueStartIndex, index, valueStartIndex + valueString.length);
						problems.push(new vscode.Diagnostic(range, errorMessage, vscode.DiagnosticSeverity.Error));
					}
				}
			}
        });
		
		const existingDiagnostics = diagnostics.get(document.uri) || [];
		const externalDiagnostics = existingDiagnostics.filter(d => d.source === 'INI Validator');
		const newDiagnostics = [...externalDiagnostics, ...problems];

		if (forceClear) {
			diagnostics.set(document.uri, []);
		}
		diagnostics.set(document.uri, newDiagnostics);
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
    vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));

	// 注册语言特性提供者
	context.subscriptions.push(
		// 跳转到定义
		vscode.languages.registerDefinitionProvider(selector, {
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
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

				// 优先处理: 悬停在键 (key) 上
				if (equalsIndex !== -1) {
					const keyPart = lineText.substring(0, equalsIndex).trim();
					const keyStartIndex = lineText.indexOf(keyPart);
					const keyEndIndex = keyStartIndex + keyPart.length;
					const keyRange = new vscode.Range(position.line, keyStartIndex, position.line, keyEndIndex);

					if (keyRange.contains(position)) {
						// 1. 查找当前所在的节
						let currentSectionName: string | null = null;
						for (let i = position.line; i >= 0; i--) {
							const searchLineText = document.lineAt(i).text.trim();
							const match = searchLineText.match(/^\s*\[([^\]:]+)/);
							if (match) {
								currentSectionName = match[1].trim();
								break;
							}
						}
						if (!currentSectionName) return null;
				
						// 2. 根据节推断类型
						const registryName = iniManager.findRegistryForSection(currentSectionName);
						let typeName = registryName ? schemaManager.getTypeForRegistry(registryName) : currentSectionName;
						
						// 3. 从 Schema 中查找键的类型信息
						if (typeName) {
							const allKeys = schemaManager.getAllKeysForType(typeName);
							let valueType: string | undefined;
					
							// 不区分大小写查找
							for (const [k, v] of allKeys.entries()) {
								if (k.toLowerCase() === keyPart.toLowerCase()) {
									valueType = v;
									break;
								}
							}
					
							if (valueType) {
								const markdown = new vscode.MarkdownString();
								markdown.appendCodeblock(`${keyPart}: ${valueType}`, 'ini');
								markdown.appendMarkdown(`属于 **${typeName}** 类型。`);
								return new vscode.Hover(markdown, keyRange);
							}
						}
						// 即使在键上悬停, 如果 Schema 中没有信息, 也不显示任何内容
						return null;
					}
				}

				// 回退逻辑: 悬停在值 (value) 或其他标识符上, 显示其节注释
				// 优化单词识别, 允许字母、数字、下划线、点、中横线
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) {
					return null;
				}

				const word = document.getText(wordRange);
				const sectionInfo = iniManager.findSection(word);
				if (sectionInfo) {
					const commentText = iniManager.getSectionComment(sectionInfo.content, word);
					if (commentText) {
						return new vscode.Hover(new vscode.MarkdownString(commentText), wordRange);
					}
				}
				
				return null;
			}
		}),
		// 自动补全
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token, context) {
				const line = document.lineAt(position.line);
				const equalsIndex = line.text.indexOf('=');
				const isKeyCompletion = equalsIndex === -1 || position.character <= equalsIndex;

				// 查找当前所在的节
				let currentSectionName: string | null = null;
				for (let i = position.line; i >= 0; i--) {
					const lineText = document.lineAt(i).text.trim();
					const match = lineText.match(/^\s*\[([^\]:]+)/);
					if (match) {
						currentSectionName = match[1].trim();
						break;
					}
				}
				if (!currentSectionName) return new vscode.CompletionList([], false);
		
				if (isKeyCompletion) {
					// --- 键补全逻辑 ---
					const registryName = iniManager.findRegistryForSection(currentSectionName);
					let keys = new Map<string, string>();
			
					if (registryName) {
						const typeName = schemaManager.getTypeForRegistry(registryName);
						if (typeName) keys = schemaManager.getAllKeysForType(typeName);
					} else {
						keys = schemaManager.getAllKeysForType(currentSectionName);
					}
			
					if (keys.size === 0) return new vscode.CompletionList([], false);
			
					const items = Array.from(keys.entries()).map(([key, valueType]) => {
						const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
						item.detail = `(${valueType})`;
						return item;
					});
					return new vscode.CompletionList(items, false);
				} else {
					// --- 值补全逻辑 ---
					const suggestions: vscode.CompletionItem[] = [];
					const currentKey = line.text.substring(0, equalsIndex).trim();

					// 1. 根据 Schema 确定值的类型
					const registryName = iniManager.findRegistryForSection(currentSectionName);
					let typeName = registryName ? schemaManager.getTypeForRegistry(registryName) : currentSectionName;
					if (typeName) {
						const allKeys = schemaManager.getAllKeysForType(typeName);
						
						let valueType: string | undefined;
						// 不区分大小写查找
						for (const [key, type] of allKeys.entries()) {
							if (key.toLowerCase() === currentKey.toLowerCase()) {
								valueType = type;
								break;
							}
						}

						if (valueType) {
							// 2a. 如果是布尔值
							if (valueType.toLowerCase() === 'bool') {
								suggestions.push(new vscode.CompletionItem('yes', vscode.CompletionItemKind.Keyword));
								suggestions.push(new vscode.CompletionItem('no', vscode.CompletionItemKind.Keyword));
								return new vscode.CompletionList(suggestions, true);
							}
							// 2b. 如果是颜色
							if (valueType === 'ColorStruct') {
								const item = new vscode.CompletionItem('R,G,B', vscode.CompletionItemKind.Color);
								item.insertText = '255,255,255';
								item.documentation = '输入一个 RGB 颜色值, 例如: 255,0,0';
								suggestions.push(item);
							}
							// 2c. 如果是 [Sections] 中定义的类型, 查找对应注册表
							const targetRegistry = schemaManager.getRegistryForType(valueType);
							if (targetRegistry) {
								const ids = iniManager.getValuesForRegistry(targetRegistry);
								ids.forEach(id => suggestions.push(new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember)));
								// 如果有基于schema的建议, 则认为是最终列表
								if (suggestions.length > 0) return new vscode.CompletionList(suggestions, true);
							}
						}
					}
					
					// 3. Fallback: 如果没有基于 Schema 的特定补全, 则提供通用补全
					const fallbackSuggestions = new Map<string, vscode.CompletionItem>();
					// 添加所有已知的节名作为候选
					iniManager.getAllSectionNames().forEach(name => {
						if (!fallbackSuggestions.has(name)) {
							fallbackSuggestions.set(name, new vscode.CompletionItem(name, vscode.CompletionItemKind.Module));
						}
					});
					// 添加当前键所有用过的值
					if (currentKey) {
						iniManager.getValuesForKey(currentKey).forEach(value => {
							if (!fallbackSuggestions.has(value)) {
								const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
								if (/^-?\d+(\.\d+)?$/.test(value)) {
									item.kind = vscode.CompletionItemKind.Constant;
								} else if (['true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
									item.kind = vscode.CompletionItemKind.Keyword;
								}
								fallbackSuggestions.set(value, item);
							}
						});
					}
					suggestions.push(...Array.from(fallbackSuggestions.values()));
					
					return new vscode.CompletionList(suggestions, false);
				}
			}
		}),
		// 颜色提供器
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document, token) {
				const colors: vscode.ColorInformation[] = [];
				for (let i = 0; i < document.lineCount; i++) {
					const line = document.lineAt(i);
					const equalsIndex = line.text.indexOf('=');
					if (equalsIndex === -1) continue;

					// 查找当前节
					let currentSectionName: string | null = null;
					for (let j = i; j >= 0; j--) {
						const lineText = document.lineAt(j).text.trim();
						const match = lineText.match(/^\s*\[([^\]:]+)/);
						if (match) {
							currentSectionName = match[1].trim();
							break;
						}
					}
					if (!currentSectionName) continue;
					
					const currentKey = line.text.substring(0, equalsIndex).trim();

					// 查找值的类型
					const registryName = iniManager.findRegistryForSection(currentSectionName);
					let typeName = registryName ? schemaManager.getTypeForRegistry(registryName) : currentSectionName;
					if (typeName) {
						const allKeys = schemaManager.getAllKeysForType(typeName);
						let valueType: string | undefined;
						for (const [key, type] of allKeys.entries()) {
							if (key.toLowerCase() === currentKey.toLowerCase()) {
								valueType = type;
								break;
							}
						}

						if (valueType === 'ColorStruct') {
							const valuePart = line.text.substring(equalsIndex + 1).split(';')[0].trim();
							const rgb = valuePart.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
							if (rgb) {
								const r = parseInt(rgb[1], 10);
								const g = parseInt(rgb[2], 10);
								const b = parseInt(rgb[3], 10);
								if (r <= 255 && g <= 255 && b <= 255) {
									const range = new vscode.Range(i, equalsIndex + 1, i, line.text.length);
									colors.push(new vscode.ColorInformation(range, new vscode.Color(r / 255, g / 255, b / 255, 1)));
								}
							}
						}
					}
				}
				return colors;
			},
			provideColorPresentations(color, context, token) {
				const r = Math.round(color.red * 255);
				const g = Math.round(color.green * 255);
				const b = Math.round(color.blue * 255);
				return [new vscode.ColorPresentation(`${r},${g},${b}`)];
			}
		}),
		// 查找引用提供器
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position, context, token) {
				const line = document.lineAt(position.line);
				// 仅当在节头 `[...]` 内时触发
				const sectionMatch = line.text.match(/^\s*\[([^\]:]+)\]/);
				if (sectionMatch) {
					const sectionName = sectionMatch[1];
					return iniManager.findReferences(sectionName);
				}
				return [];
			}
		}),
		// 代码折叠
		vscode.languages.registerFoldingRangeProvider(selector, {
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
 * 验证一个值是否符合其 Schema 定义的类型规则。
 * @param value 要验证的字符串值
 * @param valueType 值的预期类型 (来自 Schema)
 * @param schemaManager Schema 管理器实例
 * @param iniManager INI 管理器实例
 * @returns 如果验证失败，返回错误信息字符串；如果成功，返回 null
 */
function validateValueByType(value: string, valueType: string, schemaManager: SchemaManager, iniManager: INIManager): string | null {
	const category = schemaManager.getValueTypeCategory(valueType);

	switch (category) {
		case ValueTypeCategory.Primitive:
			if (valueType === 'int' && !/^-?\d+$/.test(value)) return `值 "${value}" 不是一个有效的整数 (int)。`;
			if (valueType === 'float' && isNaN(parseFloat(value))) return `值 "${value}" 不是一个有效的浮点数 (float)。`;
			return null;

		case ValueTypeCategory.NumberLimit: {
			const limit = schemaManager.getNumberLimit(valueType);
			if (!limit) return null; // 理论上不应发生
			const num = parseInt(value, 10);
			if (isNaN(num)) return `值 "${value}" 不是一个有效的整数。`;
			if (num < limit.min || num > limit.max) {
				return `值 ${value} 超出 ${valueType} 类型的范围 [${limit.min}, ${limit.max}]。`;
			}
			return null;
		}

		case ValueTypeCategory.StringLimit: {
			const limit = schemaManager.getStringLimit(valueType);
			if (!limit) return null;
			const compareValue = limit.caseSensitive ? value : value.toLowerCase();

			if (limit.limitIn) {
				const allowedValues = limit.caseSensitive ? limit.limitIn : limit.limitIn.map(v => v.toLowerCase());
				if (!allowedValues.includes(compareValue)) return `值 "${value}" 不是 ${valueType} 类型允许的值之一 (例如: ${limit.limitIn.slice(0, 3).join(', ')}...)。`;
			}
			if (limit.startWith) {
				const prefixes = limit.caseSensitive ? limit.startWith : limit.startWith.map(v => v.toLowerCase());
				if (!prefixes.some(p => compareValue.startsWith(p))) return `值 "${value}" 不符合 ${valueType} 类型的前缀要求。`;
			}
			if (limit.endWith) {
				const suffixes = limit.caseSensitive ? limit.endWith : limit.endWith.map(v => v.toLowerCase());
				if (!suffixes.some(s => compareValue.endsWith(s))) return `值 "${value}" 不符合 ${valueType} 类型的后缀要求。`;
			}
			return null;
		}

		case ValueTypeCategory.List: {
			const definition = schemaManager.getListDefinition(valueType);
			if (!definition) return null;
			const items = value.split(',').map(item => item.trim());

			if (definition.minRange !== undefined && items.length < definition.minRange) return `${valueType} 类型要求至少 ${definition.minRange} 个值，但只提供了 ${items.length} 个。`;
			if (definition.maxRange !== undefined && items.length > definition.maxRange) return `${valueType} 类型要求最多 ${definition.maxRange} 个值，但提供了 ${items.length} 个。`;
			
			for (const item of items) {
				const itemError = validateValueByType(item, definition.type, schemaManager, iniManager);
				if (itemError) return `列表中的值 "${item}" 无效: ${itemError}`;
			}
			return null;
		}

		case ValueTypeCategory.Section:
			if (!iniManager.findSection(value)) {
				return `未在项目中找到节 '[${value}]' 的定义。`;
			}
			return null;
			
		default:
			return null;
	}
}


/**
 * 扩展的停用函数, 用于清理资源
 */
export function deactivate() {
	// 目前无需清理
}