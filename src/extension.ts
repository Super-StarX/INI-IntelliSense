import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';
import { DynamicThemeManager } from './dynamic-theme';
import { DiagnosticEngine } from './diagnostics/engine';
import { ErrorCode } from './diagnostics/error-codes';
import { IniDiagnostic } from './diagnostics/diagnostic';
import { OverrideDecorator } from './override-decorator';

let diagnostics: vscode.DiagnosticCollection;
const LANGUAGE_ID = 'ra2-ini';

/**
 * 扩展的主激活函数。
 * 当扩展被激活时（例如，首次打开 INI 文件时），此函数将被调用。
 * 它负责初始化所有功能、注册命令和事件监听器。
 * @param context 扩展的上下文，用于管理订阅和状态。
 */
export async function activate(context: vscode.ExtensionContext) {
	// 创建一个用于输出调试信息的专用输出频道
	const outputChannel = vscode.window.createOutputChannel("INI IntelliSense");
	
	// 初始化核心管理器
	const iniManager = new INIManager();
	const outlineProvider = new INIOutlineProvider(context, iniManager);
	const schemaManager = new SchemaManager();
	iniManager.setSchemaManager(schemaManager);
	const diagnosticEngine = new DiagnosticEngine();

	const selector = { language: LANGUAGE_ID };

	// 初始化动态主题管理器，负责自定义语法高亮
	const themeManager = new DynamicThemeManager();
	context.subscriptions.push(themeManager);

	// 初始化继承覆盖装饰器
	const overrideDecorator = new OverrideDecorator(context, iniManager, schemaManager);
	context.subscriptions.push(overrideDecorator);

	// 创建并配置状态栏图标，用于显示和管理 Schema 文件
	const schemaStatusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	schemaStatusbar.command = 'ra2-ini-intellisense.configureSchemaPath';
	context.subscriptions.push(schemaStatusbar);

	// 注册诊断集合，用于在编辑器中显示错误和警告
	diagnostics = vscode.languages.createDiagnosticCollection('ini');
	const iniValidator = new INIValidatorExt(diagnostics);
	await iniValidator.initialize(context);

	context.subscriptions.push(diagnostics);

	// 注册大纲视图及其刷新命令
	context.subscriptions.push(vscode.window.createTreeView('ini-outline', { treeDataProvider: outlineProvider }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshOutline', () => outlineProvider.refresh()));

	/**
	 * 扫描工作区内的所有 .ini 文件，并建立索引。
	 * 这是实现跳转、引用查找和类型推断等功能的数据基础。
	 */
	async function indexWorkspaceFiles() {
		const iniFiles = await vscode.workspace.findFiles('**/*.ini');
		await iniManager.indexFiles(iniFiles);
		console.log(`INI IntelliSense: 已索引 ${iniManager.files.size} 个INI文件。`);
		outlineProvider.refresh();
	}

	/**
	 * 根据 Schema 文件的加载状态，更新状态栏图标的显示。
	 * @param loadedPath 已加载的 Schema 文件路径，如果未加载则为 null。
	 */
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

	/**
	 * 从用户配置中加载 Schema 文件。
	 * 它会优先使用明确指定的路径，如果未指定，则尝试从 INIValidator.exe 的路径推断。
	 */
	async function loadSchemaFromConfiguration() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		let loadedPath: string | null = null;
		let schemaPath = config.get<string | null>('schemaFilePath', null);
		const isExplicitPath = !!schemaPath;

		if (!schemaPath) {
			const exePath = config.get<string | null>('exePath', null);
			if (exePath) {
				const exeDir = path.dirname(exePath);
				schemaPath = path.join(exeDir, 'INICodingCheck.ini');
			}
		}

		if (schemaPath) {
			try {
				const schemaUri = vscode.Uri.file(schemaPath);
				const schemaContentBytes = await vscode.workspace.fs.readFile(schemaUri);
				const schemaContent = Buffer.from(schemaContentBytes).toString('utf-8');
				schemaManager.loadSchema(schemaContent, schemaPath);
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
			schemaManager.clearSchema();
		}
		
		updateSchemaStatus(loadedPath);
		await indexWorkspaceFiles();
	}
	
	// 注册命令：配置 Schema 文件路径
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.configureSchemaPath', async () => {
		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: 'Select INICodingCheck.ini',
			filters: { 'INI Files': ['ini'] }
		};
		const fileUri = await vscode.window.showOpenDialog(options);
		if (fileUri && fileUri[0]) {
			await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', fileUri[0].fsPath, vscode.ConfigurationTarget.Global);
		}
	}));

	// 注册内部命令：用于从悬浮提示中点击跳转
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.jumpToOverride', async (args) => {
		const { uri, position } = args;
		const targetUri = vscode.Uri.parse(uri);
		const targetPosition = new vscode.Position(position.line, position.character);
		
		const document = await vscode.workspace.openTextDocument(targetUri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(targetPosition, targetPosition);
		editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
	}));


	// 首次激活时，立即加载一次 Schema
	await loadSchemaFromConfiguration();
	overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();

	// 注册并管理代码透镜 (CodeLens) 提供程序
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
								const valueRefs = iniManager.valueReferences.get(sectionName) || [];
								const inheritanceRefs = iniManager.inheritanceReferences.get(sectionName) || [];
								
								const range = new vscode.Range(i, 0, i, line.text.length);
								const parts: string[] = [];

								if (valueRefs.length > 0) {
									parts.push(`${valueRefs.length} 次引用`);
								}
								if (inheritanceRefs.length > 0) {
									parts.push(`${inheritanceRefs.length} 次被继承`);
								}
		
								let title: string;
								if (parts.length > 0) {
									title = parts.join(', ');
								} else {
									title = '0 次引用 (可能未使用)';
								}
		
								codeLenses.push(new vscode.CodeLens(range, {
									title: title,
									command: 'editor.action.findReferences',
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

	// 监听配置变更，动态更新功能
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		let needsFullDiagnosticUpdate = false;
		let needsDecoratorUpdate = false;

		if (e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') || e.affectsConfiguration('ra2-ini-intellisense.exePath')) {
			await loadSchemaFromConfiguration();
			needsFullDiagnosticUpdate = true;
			needsDecoratorUpdate = true;
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.codeLens.enabled')) {
			updateCodeLensProvider();
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.diagnostics')) {
			needsFullDiagnosticUpdate = true;
		}
		if (needsFullDiagnosticUpdate) {
			vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));
		}
		if (needsDecoratorUpdate) {
			overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.colors')) {
			themeManager.reloadDecorations();
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.decorations')) {
			overrideDecorator.reload();
		}
	}));
	updateCodeLensProvider();

	// 监听文件系统事件，保持索引最新
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindexAndUpdateDiagnostics = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在重新索引...`);
		await indexWorkspaceFiles();
		vscode.workspace.textDocuments.forEach(doc => {
			updateDiagnostics(doc);
			overrideDecorator.triggerUpdateDecorations(doc.uri);
		});
	};

	watcher.onDidCreate(reindexAndUpdateDiagnostics);
	watcher.onDidDelete(reindexAndUpdateDiagnostics);
	watcher.onDidChange(reindexAndUpdateDiagnostics);

	// 注册调试命令：显示当前上下文的详细调试信息
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

		const typeName = iniManager.getTypeForSection(currentSectionName);
		if (typeName) {
			outputChannel.appendLine(`✅ 推断类型为: '${typeName}'`);

			const debugLines = schemaManager.getDebugInfoForType(typeName);
			outputChannel.appendLine("\n--- 类型继承与键值分析 ---");
			debugLines.forEach(line => outputChannel.appendLine(line));

			const allKeys = schemaManager.getAllKeysForType(typeName);
			if (allKeys.size > 0) {
				outputChannel.appendLine(`\n✅ 总可用键 (包含继承): ${allKeys.size} 个`);
			} else {
				outputChannel.appendLine(`\n❌ 警告: 在分析继承链后，未找到类型 '${typeName}' 的任何键。`);
			}
		} else {
			outputChannel.appendLine(`\n❌ 错误: 无法确定要分析的类型。`);
		}
		
		outputChannel.show();
	}));

    /**
     * 更新单个文档的诊断信息。
	 * 此函数作为协调者，调用诊断引擎来执行所有实际的检查工作。
     * @param document 需要更新诊断的文本文档
     * @param contentChanges 文档变更的数组，用于增量更新
     */
    const updateDiagnostics = async (document: vscode.TextDocument, contentChanges?: readonly vscode.TextDocumentContentChangeEvent[]) => {
        if (document.languageId !== LANGUAGE_ID) {
            return;
        }

		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
		const disabledErrorCodes = new Set<ErrorCode>(config.get<string[]>('disable', []).map(code => code as ErrorCode));

		const context = {
			document,
			schemaManager,
			iniManager,
			config,
			disabledErrorCodes
		};

		const existingDiagnostics = diagnostics.get(document.uri) || [];
		const externalDiagnostics = existingDiagnostics.filter(d => d.source === 'INI Validator');
		let internalDiagnostics: IniDiagnostic[];

		// 如果没有变更信息，或变更信息为空，则执行全量扫描
		if (!contentChanges || contentChanges.length === 0) {
			internalDiagnostics = diagnosticEngine.analyze(context);
			diagnostics.set(document.uri, [...externalDiagnostics, ...internalDiagnostics]);
			return;
		}

		// 增量更新逻辑
		let minLine = Infinity;
		let maxLine = -1;
		for (const change of contentChanges) {
			minLine = Math.min(minLine, change.range.start.line);
			const changeEndLine = change.range.start.line + (change.text.match(/\n/g) || []).length;
			maxLine = Math.max(maxLine, changeEndLine, change.range.end.line);
		}

		if (minLine > maxLine) {
			return; // 没有实际的行变更
		}

		const affectedRange = new vscode.Range(minLine, 0, maxLine, Number.MAX_SAFE_INTEGER);
		const newInternalDiagnostics = diagnosticEngine.analyze(context, affectedRange);
		
		// 过滤掉受影响范围内的旧诊断，然后合并新的诊断
		const unaffectedDiagnostics = existingDiagnostics.filter(
			(d): d is IniDiagnostic => d.source !== 'INI Validator' && !affectedRange.contains(d.range)
		);
		internalDiagnostics = [...unaffectedDiagnostics, ...newInternalDiagnostics];

		diagnostics.set(document.uri, [...externalDiagnostics, ...internalDiagnostics]);
    };

	// 监听文档事件，实时更新诊断
    vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document, event.contentChanges));
    vscode.workspace.onDidOpenTextDocument(document => updateDiagnostics(document));
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri));

    // 为所有已打开的文件初始运行一次诊断
    vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));

	// 注册所有语言特性提供者
	context.subscriptions.push(
		// 跳转到定义
		vscode.languages.registerDefinitionProvider(selector, {
			async provideDefinition(document, position, token) {
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) {return null;}
				const word = document.getText(wordRange);

				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}

				const locations: vscode.Location[] = [];
				for (const [filePath, data] of iniManager.files.entries()) {
					if (filePath === document.uri.fsPath) {continue;}
					const line = iniManager.findSectionInContent(data.content, word);
					if (line !== null) {
						locations.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(line, 0)));
					}
				}

				if (locations.length === 1) {return locations[0];}
				
				return null;
			}
		}),
		// 悬停提示
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

				if (equalsIndex === -1) { // 如果不是键值对行，检查是否悬停在值上
					const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
					if (!wordRange) {return null;}

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

				// --- 以下是处理键的悬停逻辑 ---
				const keyPart = lineText.substring(0, equalsIndex).trim();
				const keyRange = new vscode.Range(position.line, line.firstNonWhitespaceCharacterIndex, position.line, equalsIndex);

				if (!keyRange.contains(position)) {return null;}

				let currentSectionName: string | null = null;
				for (let i = position.line; i >= 0; i--) {
					const searchLineText = document.lineAt(i).text.trim();
					const match = searchLineText.match(/^\s*\[([^\]:]+)/);
					if (match) {
						currentSectionName = match[1].trim();
						break;
					}
				}
				if (!currentSectionName) {return null;}
		
				const markdown = new vscode.MarkdownString("", true);
				markdown.isTrusted = true;
				markdown.supportThemeIcons = true;
				let hasContent = false;

				// --- 模块1: 查找并附加类型信息 ---
				const typeName = iniManager.getTypeForSection(currentSectionName);
				if (typeName) {
					const allKeys = schemaManager.getAllKeysForType(typeName);
					let valueType: string | undefined;
					for (const [k, v] of allKeys.entries()) {
						if (k.toLowerCase() === keyPart.toLowerCase()) {
							valueType = v;
							break;
						}
					}
			
					if (valueType) {
						markdown.appendCodeblock(`${keyPart}: ${valueType}`, 'ini');
						markdown.appendMarkdown(`属于 **${typeName}** 类型。`);
						hasContent = true;
					}
				}

				// --- 模块2: 查找并附加覆盖信息 (使用正确的递归实例查找) ---
				const parentInstanceName = iniManager.getInheritance(currentSectionName);
				if (parentInstanceName) {
					const parentKeyInfo = iniManager.findKeyLocationRecursive(parentInstanceName, keyPart); 
					
					if (parentKeyInfo && parentKeyInfo.location && parentKeyInfo.lineText && parentKeyInfo.definer) {
						if(hasContent) {markdown.appendMarkdown('\n\n---\n\n');}

						const lineNum = parentKeyInfo.location.range.start.line + 1;
						const fileName = path.basename(parentKeyInfo.location.uri.fsPath);

						markdown.appendMarkdown(`此键覆盖了基类的值 **${fileName}**:L${lineNum}`);
						
						const parentValueMatch = parentKeyInfo.lineText.match(/=\s*(.*)/);
						const parentValueRaw = parentValueMatch ? parentValueMatch[1].trim() : '';
						const parentValue = parentValueRaw.split(';')[0].trim();

						markdown.appendCodeblock(`[${parentKeyInfo.definer}]\n${keyPart}=${parentValue || ''}`, 'ini');

						const args = {
							uri: parentKeyInfo.location.uri.toString(),
							position: parentKeyInfo.location.range.start
						};
						const commandUri = vscode.Uri.parse(`command:ra2-ini-intellisense.jumpToOverride?${encodeURIComponent(JSON.stringify(args))}`);
						markdown.appendMarkdown(`[$(go-to-file) 跳转到父类定义](${commandUri})`);
						hasContent = true;
					}
				}

				return hasContent ? new vscode.Hover(markdown, keyRange) : null;
			}
		}),

		// 自动补全
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token, context) {
				const line = document.lineAt(position.line);
				const equalsIndex = line.text.indexOf('=');
				const isKeyCompletion = equalsIndex === -1 || position.character <= equalsIndex;

				let currentSectionName: string | null = null;
				for (let i = position.line; i >= 0; i--) {
					const lineText = document.lineAt(i).text.trim();
					const match = lineText.match(/^\s*\[([^\]:]+)/);
					if (match) {
						currentSectionName = match[1].trim();
						break;
					}
				}
				if (!currentSectionName) {return new vscode.CompletionList([], false);}
		
				const typeName = iniManager.getTypeForSection(currentSectionName);
				if (!typeName) {return new vscode.CompletionList([], false);}

				if (isKeyCompletion) {
					const keys = schemaManager.getAllKeysForType(typeName);
					if (keys.size === 0) {return new vscode.CompletionList([], false);}
			
					const items = Array.from(keys.entries()).map(([key, valueType]) => {
						const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
						item.detail = `(${valueType})`;
						return item;
					});
					return new vscode.CompletionList(items, false);
				} else {
					const suggestions: vscode.CompletionItem[] = [];
					const currentKey = line.text.substring(0, equalsIndex).trim();
					const allKeys = schemaManager.getAllKeysForType(typeName);
						
					let valueType: string | undefined;
					for (const [key, type] of allKeys.entries()) {
						if (key.toLowerCase() === currentKey.toLowerCase()) {
							valueType = type;
							break;
						}
					}

					if (valueType) {
						if (valueType.toLowerCase() === 'bool') {
							suggestions.push(new vscode.CompletionItem('yes', vscode.CompletionItemKind.Keyword));
							suggestions.push(new vscode.CompletionItem('no', vscode.CompletionItemKind.Keyword));
							return new vscode.CompletionList(suggestions, true);
						}
						if (valueType === 'ColorStruct') {
							const item = new vscode.CompletionItem('R,G,B', vscode.CompletionItemKind.Color);
							item.insertText = '255,255,255';
							item.documentation = '输入一个 RGB 颜色值, 例如: 255,0,0';
							suggestions.push(item);
						}
						const targetRegistry = schemaManager.getRegistryForType(valueType);
						if (targetRegistry) {
							const ids = iniManager.getValuesForRegistry(targetRegistry);
							ids.forEach(id => suggestions.push(new vscode.CompletionItem(id, vscode.CompletionItemKind.EnumMember)));
							if (suggestions.length > 0) {return new vscode.CompletionList(suggestions, true);}
						}
					}
					
					const fallbackSuggestions = new Map<string, vscode.CompletionItem>();
					iniManager.getAllSectionNames().forEach(name => {
						if (!fallbackSuggestions.has(name)) {
							fallbackSuggestions.set(name, new vscode.CompletionItem(name, vscode.CompletionItemKind.Module));
						}
					});
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
		// 颜色拾取器
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document, token) {
				const colors: vscode.ColorInformation[] = [];
				for (let i = 0; i < document.lineCount; i++) {
					const line = document.lineAt(i);
					const equalsIndex = line.text.indexOf('=');
					if (equalsIndex === -1) {continue;}

					let currentSectionName: string | null = null;
					for (let j = i; j >= 0; j--) {
						const lineText = document.lineAt(j).text.trim();
						const match = lineText.match(/^\s*\[([^\]:]+)/);
						if (match) {
							currentSectionName = match[1].trim();
							break;
						}
					}
					if (!currentSectionName) {continue;}
					
					const currentKey = line.text.substring(0, equalsIndex).trim();
					const typeName = iniManager.getTypeForSection(currentSectionName);

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
		// 查找所有引用
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position, context, token) {
				const line = document.lineAt(position.line);
				const sectionMatch = line.text.match(/^\s*\[([^\]:]+)\]/);
				if (sectionMatch) {
					const sectionName = sectionMatch[1];
					const valueRefs = iniManager.valueReferences.get(sectionName) || [];
					const inheritanceRefs = iniManager.inheritanceReferences.get(sectionName) || [];
					return [...valueRefs, ...inheritanceRefs];
				}
				return [];
			}
		}),
		// 代码折叠
		vscode.languages.registerFoldingRangeProvider(selector, {
			provideFoldingRanges(document, context, token) {
				const result = [];
				const sectionRegex = /^\s*\[([^\]]+)\]/;
				let prevSecName = null;
				let prevSecLineStart = 0;
				let prevSecLineEnd = null;

				for (let line = 0; line < document.lineCount; line++) {
					const { text } = document.lineAt(line);
					const secMatched = text.match(sectionRegex);
					if (secMatched) {
						if (prevSecName !== null) {
							prevSecLineEnd = line - 1;
							if (prevSecLineEnd > prevSecLineStart) {
								result.push(new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region));
							}
						}
						prevSecName = secMatched[1];
						prevSecLineStart = line;
					}
				}

				if (prevSecName !== null) {
					prevSecLineEnd = document.lineCount - 1;
					if (prevSecLineEnd > prevSecLineStart) {
						result.push(new vscode.FoldingRange(prevSecLineStart, prevSecLineEnd, vscode.FoldingRangeKind.Region));
					}
				}
				return result;
			}
		}),
	);
}

/**
 * 扩展的停用函数，用于清理资源。
 */
export function deactivate() {
	diagnostics.dispose();
}