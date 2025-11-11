import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';
import { DynamicThemeManager } from './dynamic-theme';
import { DiagnosticEngine } from './diagnostics/engine';
import { ErrorCode } from './diagnostics/error-codes';

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
	iniManager.setSchemaManager(schemaManager);
	const diagnosticEngine = new DiagnosticEngine();

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
	await iniValidator.initialize(context);

	context.subscriptions.push(diagnostics);

	// 注册大纲视图
	context.subscriptions.push(vscode.window.createTreeView('ini-outline', { treeDataProvider: outlineProvider }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshOutline', () => outlineProvider.refresh()));

	// 建立工作区INI文件索引
	async function indexWorkspaceFiles() {
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
			schemaManager.clearSchema();
		}
		
		updateSchemaStatus(loadedPath);
		await indexWorkspaceFiles();
	}
	
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

	await loadSchemaFromConfiguration();

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

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('ra2-ini-intellisense.schemaFilePath') || e.affectsConfiguration('ra2-ini-intellisense.exePath')) {
			await loadSchemaFromConfiguration();
			vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.codeLens.enabled')) {
			updateCodeLensProvider();
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.diagnostics')) {
			vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));
		}
		if (e.affectsConfiguration('ra2-ini-intellisense.colors')) {
			themeManager.reloadDecorations();
		}
	}));
	updateCodeLensProvider();

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const reindexAndUpdateDiagnostics = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在重新索引...`);
		await indexWorkspaceFiles();
		vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));
	};

	watcher.onDidCreate(reindexAndUpdateDiagnostics);
	watcher.onDidDelete(reindexAndUpdateDiagnostics);
	watcher.onDidChange(reindexAndUpdateDiagnostics);

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
     * @param document 需要更新诊断的文本文档
     */
    const updateDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== LANGUAGE_ID) {
            return;
        }

		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
		const disabledErrorCodes = new Set<ErrorCode>(config.get<string[]>('disable', []).map(code => code as ErrorCode));

		const internalDiagnostics = diagnosticEngine.analyze({
			document,
			schemaManager,
			iniManager,
			config,
			disabledErrorCodes
		});
		
		const existingDiagnostics = diagnostics.get(document.uri) || [];
		const externalDiagnostics = existingDiagnostics.filter(d => d.source === 'INI Validator');
		
		diagnostics.set(document.uri, [...externalDiagnostics, ...internalDiagnostics]);
    };

    vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document));
    vscode.workspace.onDidOpenTextDocument(document => updateDiagnostics(document));
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri));

    vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(selector, {
			async provideDefinition(document, position, token) {
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) return null;
				const word = document.getText(wordRange);

				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}

				const locations: vscode.Location[] = [];
				for (const [filePath, data] of iniManager.files.entries()) {
					if (filePath === document.uri.fsPath) continue;
					const line = iniManager.findSectionInContent(data.content, word);
					if (line !== null) {
						locations.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(line, 0)));
					}
				}

				if (locations.length === 1) return locations[0];
				if (locations.length > 1) return locations;

				vscode.window.showInformationMessage(`未找到节 '[${word}]' 的定义`);
				return null;
			}
		}),
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

				if (equalsIndex !== -1) {
					const keyPart = lineText.substring(0, equalsIndex).trim();
					const keyRange = new vscode.Range(position.line, line.firstNonWhitespaceCharacterIndex, position.line, equalsIndex);

					if (keyRange.contains(position)) {
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
								const markdown = new vscode.MarkdownString();
								markdown.appendCodeblock(`${keyPart}: ${valueType}`, 'ini');
								markdown.appendMarkdown(`属于 **${typeName}** 类型。`);
								return new vscode.Hover(markdown, keyRange);
							}
						}
						return null;
					}
				}

				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) return null;

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
				if (!currentSectionName) return new vscode.CompletionList([], false);
		
				const typeName = iniManager.getTypeForSection(currentSectionName);
				if (!typeName) return new vscode.CompletionList([], false);

				if (isKeyCompletion) {
					const keys = schemaManager.getAllKeysForType(typeName);
					if (keys.size === 0) return new vscode.CompletionList([], false);
			
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
							if (suggestions.length > 0) return new vscode.CompletionList(suggestions, true);
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
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document, token) {
				const colors: vscode.ColorInformation[] = [];
				for (let i = 0; i < document.lineCount; i++) {
					const line = document.lineAt(i);
					const equalsIndex = line.text.indexOf('=');
					if (equalsIndex === -1) continue;

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
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position, context, token) {
				const line = document.lineAt(position.line);
				const sectionMatch = line.text.match(/^\s*\[([^\]:]+)\]/);
				if (sectionMatch) {
					const sectionName = sectionMatch[1];
					return iniManager.findReferences(sectionName);
				}
				return [];
			}
		}),
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
 * 扩展的停用函数, 用于清理资源
 */
export function deactivate() {
	diagnostics.dispose();
}