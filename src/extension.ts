import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';

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

	// 监听配置变更，当用户修改 schema 文件路径或 IV 路径时自动重新加载
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') || e.affectsConfiguration('ra2-ini-intellisense.exePath')) {
			await loadSchemaFromConfiguration();
		}
	}));

	// 监听文件变化, 保持索引最新
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindex = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在重新索引工作区...`);
		await indexWorkspaceFiles();
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
     */
    const updateDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== LANGUAGE_ID) {
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

	const selector = { language: LANGUAGE_ID };
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
		// 代码透镜提供器
		vscode.languages.registerCodeLensProvider(selector, {
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
 * 扩展的停用函数, 用于清理资源
 */
export function deactivate() {
	// 目前无需清理
}