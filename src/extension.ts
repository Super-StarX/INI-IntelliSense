import * as vscode from 'vscode';
import * as path from 'path';
import { INIManager } from './parser';
import { INIValidatorExt } from './ini-validator-ext';
import { INIOutlineProvider } from './outline-provider';
import { SchemaManager } from './schema-manager';
import { IniSemanticTokensProvider, legend } from './semantic-tokens-provider';
import { DiagnosticEngine } from './diagnostics/engine';
import { ErrorCode } from './diagnostics/error-codes';
import { IniDiagnostic } from './diagnostics/diagnostic';
import { OverrideDecorator } from './override-decorator';
import { WelcomePanel } from './welcome-panel';
import { localize, initializeNls } from './i18n';
import { IniRenameProvider } from './refactoring/rename-provider';
import { IniCodeActionProvider } from './refactoring/code-actions';
import { registerRegisterIdCommand } from './refactoring/register-id';
import { registerExtractSuperclassCommand } from './refactoring/extract-superclass';
import { registerFormattingCommands } from './formatting/formatter';
import { DictionaryService } from './dictionary-service';

let diagnostics: vscode.DiagnosticCollection;
const LANGUAGE_ID = 'ra2-ini';

/**
 * 扩展的主激活函数。
 * 当扩展被激活时（例如，首次打开 INI 文件时），此函数将被调用。
 * 它负责初始化所有功能、注册命令和事件监听器。
 * @param context 扩展的上下文，用于管理订阅和状态。
 */
export async function activate(context: vscode.ExtensionContext) {
    initializeNls(context);
	const outputChannel = vscode.window.createOutputChannel(localize('output.channel.name', 'INI IntelliSense'));
	
	const iniManager = new INIManager();
	const outlineProvider = new INIOutlineProvider(context, iniManager);
	const schemaManager = new SchemaManager();
	iniManager.setSchemaManager(schemaManager);
	const diagnosticEngine = new DiagnosticEngine();
	let isIndexing = false; // 跟踪是否正在进行索引
    let isDiagnosing = false; // 跟踪是否正在进行诊断

	const selector = { language: LANGUAGE_ID };

	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(selector, new IniSemanticTokensProvider(), legend)
	);

	const overrideDecorator = new OverrideDecorator(context, iniManager, schemaManager);
	context.subscriptions.push(overrideDecorator);

	// 创建一个统一的状态栏入口
	const mainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	mainStatusBar.command = 'ra2-ini-intellisense.showMainQuickPick';
	context.subscriptions.push(mainStatusBar);

	diagnostics = vscode.languages.createDiagnosticCollection('ini');
	const iniValidator = new INIValidatorExt(diagnostics);
    const dictionaryService = new DictionaryService(context);
	// 不要 await 初始化，让它在后台运行
	iniValidator.initialize(context);
	// 监听校验器状态变化，以更新统一状态栏
	context.subscriptions.push(iniValidator.onDidChangeStatus(() => updateMainStatus()));

	context.subscriptions.push(diagnostics);

	context.subscriptions.push(vscode.window.createTreeView('ini-outline', { treeDataProvider: outlineProvider }));
    context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.refreshOutline', () => outlineProvider.refresh()));

    // 辅助函数：获取有效的项目根目录
    // 优先级：用户配置 > 当前工作区第一个文件夹 > undefined
    function getProjectRoot(): string | undefined {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const configPath = config.get<string | null>('validationFolderPath');
        if (configPath) {
            return configPath;
        }
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

	async function indexWorkspaceFiles() {
		if (isIndexing) { return; } // 防止重复索引
		isIndexing = true;
		updateMainStatus(); // 更新状态栏为“正在索引”

		try {
			const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
			const includePatterns = config.get<string[]>('indexing.includePatterns', []);
			const excludePatterns = config.get<string[]>('indexing.excludePatterns', []);
			
            const projectRoot = getProjectRoot();

			if (!projectRoot || includePatterns.length === 0) {
				// 如果既没配置路径，也没打开文件夹，或者没有包含模式，则无法索引
				console.log('INI IntelliSense: 未找到有效项目根目录或包含模式，跳过文件索引。');
				await iniManager.indexFiles([]);
				outlineProvider.refresh();
				return;
			}
            
            const searchRoot = vscode.Uri.file(projectRoot);
			const includePattern = new vscode.RelativePattern(searchRoot, `{${includePatterns.join(',')}}`);
			const excludePattern = excludePatterns.length > 0 ? new vscode.RelativePattern(searchRoot, `{${excludePatterns.join(',')}}`) : null;
			
			const iniFiles = await vscode.workspace.findFiles(includePattern, excludePattern);
			await iniManager.indexFiles(iniFiles);
			const indexedFiles = Array.from(iniManager.files.keys()).map(p => path.basename(p));
			console.log(`INI IntelliSense: 已索引 ${iniManager.files.size} 个INI文件: [${indexedFiles.join(', ')}]`);
			outlineProvider.refresh();
		} finally {
			isIndexing = false;
			updateMainStatus(); // 索引完成，恢复正常状态
		}
	}
	
	function updateMainStatus() {
		if (isIndexing) {
			mainStatusBar.text = `$(sync~spin) INI: ${localize('statusbar.indexing', 'Indexing...')}`;
			mainStatusBar.tooltip = localize('statusbar.indexing.tooltip', 'Indexing INI files in the workspace, some features may be temporarily unavailable.');
			mainStatusBar.backgroundColor = undefined;
			mainStatusBar.show();
			return;
		}

        if (isDiagnosing) {
            mainStatusBar.text = `$(beaker) INI: ${localize('statusbar.diagnosing', 'Diagnosing...')}`;
            mainStatusBar.tooltip = "Running diagnostics on open files...";
            mainStatusBar.backgroundColor = undefined;
            mainStatusBar.show();
            return;
        }

		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const projectRoot = getProjectRoot();

		if (!projectRoot) {
            // 只有当既没配置，也没打开文件夹时，才显示警告
			mainStatusBar.text = `$(folder) INI: ${localize('statusbar.setProjectRoot', 'Set Project Root')}`;
			mainStatusBar.tooltip = localize('statusbar.setProjectRoot.tooltip', 'Mod root directory is not set. Click to configure to enable file indexing and diagnostics.');
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (!schemaManager.isSchemaLoaded()) {
			const dictPath = config.get<string>('schemaFilePath');
			mainStatusBar.text = `$(book) INI: ${localize('statusbar.setDictionary', 'Set Dictionary')}`;
			mainStatusBar.tooltip = dictPath 
				? localize('statusbar.setDictionary.tooltip.failed', 'Failed to load INI Dictionary file: {0}\nClick to reconfigure.', dictPath)
				: localize('statusbar.setDictionary.tooltip.notSet', 'INI Dictionary file is not set. Click to configure to enable IntelliSense.');
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (iniValidator.status === 'invalid') {
			mainStatusBar.text = `$(error) INI Validator`;
			mainStatusBar.tooltip = localize('statusbar.validator.invalid.tooltip', 'INI Validator configuration error: {0}\nClick to manage.', iniValidator.statusDetails);
			mainStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			mainStatusBar.text = `$(check) INI: ${localize('statusbar.ready', 'Ready')}`;
			const dictPath = config.get<string>('schemaFilePath')!;
			
			let tooltip = localize('statusbar.ready.tooltip.base', 'INI IntelliSense is ready') +
				`\n- ${localize('statusbar.ready.tooltip.project', 'Project')}: ${path.basename(projectRoot)}` +
				`\n- ${localize('statusbar.ready.tooltip.dictionary', 'Dictionary')}: ${path.basename(dictPath)}` +
				`\n- ${localize('statusbar.ready.tooltip.indexed', 'Indexed Files')}: ${iniManager.files.size}`;
			
			if(iniValidator.status === 'ready') {
				tooltip += `\n- ${localize('statusbar.ready.tooltip.validator', 'Validator')}: ${localize('statusbar.ready.tooltip.validator.ready', 'Ready')}`;
			} else {
				tooltip += `\n- ${localize('statusbar.ready.tooltip.validator', 'Validator')}: ${localize('statusbar.ready.tooltip.validator.notConfigured', 'Not Configured')}`;
			}
			mainStatusBar.tooltip = tooltip;
			mainStatusBar.backgroundColor = undefined;
		}
		mainStatusBar.show();
	}
    
	async function loadSchemaFromConfiguration() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		let schemaPath = config.get<string | null>('schemaFilePath', null);
		
		if (schemaPath) {
			try {
				const schemaUri = vscode.Uri.file(schemaPath);
				const schemaContentBytes = await vscode.workspace.fs.readFile(schemaUri);
				const schemaContent = Buffer.from(schemaContentBytes).toString('utf-8');
				schemaManager.loadSchema(schemaContent, schemaPath);
			} catch (error) {
				schemaManager.clearSchema();
				vscode.window.showErrorMessage(localize('schema.load.failure', 'Failed to load the specified INI Dictionary file: {0}.', schemaPath));
			}
		} else {
			schemaManager.clearSchema();
		}
		
		// 索引依赖于schema，所以放在这里。注意：这里不 await
		indexWorkspaceFiles();
        // 加载完成后，立即触发诊断
        // 优先诊断当前活动编辑器，提升体验
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === LANGUAGE_ID) {
            triggerUpdateDiagnostics(vscode.window.activeTextEditor.document);
        }
        // 然后对所有其他可见编辑器进行诊断
        vscode.window.visibleTextEditors.forEach(editor => {
            if (editor !== vscode.window.activeTextEditor && editor.document.languageId === LANGUAGE_ID) {
                triggerUpdateDiagnostics(editor.document);
            }
        });
	}
	
	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.configureSchemaPath', async () => {
		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: localize('command.configureSchema.openLabel', 'Select INIDictionary.ini'),
			filters: { [localize('command.configureSchema.filterLabel', 'INI Files')]: ['ini'] }
		};
		const fileUri = await vscode.window.showOpenDialog(options);
		if (fileUri && fileUri[0]) {
			await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', fileUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
		}
	}));
	
	async function configureModPath() {
        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择Mod根目录'
        };
        const folderUri = await vscode.window.showOpenDialog(options);
        if (folderUri && folderUri[0]) {
            await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('validationFolderPath', folderUri[0].fsPath, vscode.ConfigurationTarget.Workspace);
        }
    }

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showWelcomePage', () => {
		WelcomePanel.createOrShow(context);
	}));
	
	// 注册重构命令
	registerExtractSuperclassCommand(iniManager);
	registerRegisterIdCommand(iniManager, schemaManager);
	registerFormattingCommands();

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showMainQuickPick', async () => {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const notSetDescription = localize('mainMenu.description.notSet', 'Click to set');

        // 使用 getProjectRoot 获取当前实际生效的路径
        const projectRoot = getProjectRoot();
        const dictPath = config.get<string>('schemaFilePath');

        const modPathDesc = projectRoot 
            ? localize('mainMenu.description.modPath', 'Current: {0}', path.basename(projectRoot)) 
            : notSetDescription;
        const dictPathDesc = dictPath
            ? localize('mainMenu.description.dictPath', 'Current: {0}', path.basename(dictPath))
            : notSetDescription;

        let validatorStatusText: string;
        switch(iniValidator.status) {
            case 'ready': 
                validatorStatusText = localize('validator.status.ready.short', 'Ready'); 
                break;
            case 'invalid': 
                validatorStatusText = localize('validator.status.invalid.short', 'Invalid Path'); 
                break;
            case 'unconfigured':
            default: 
                validatorStatusText = localize('validator.status.unconfigured.short', 'Not Configured'); 
                break;
        }
        const validatorDesc = localize('mainMenu.description.validatorStatus', 'Status: {0}', validatorStatusText);


		const items: vscode.QuickPickItem[] = [
			{ label: "$(rocket) 显示设置向导", description: "重新打开首次配置页面" },
			{ label: "$(folder) 设置Mod根目录...", description: modPathDesc },
			{ label: "$(book) 设置INI Dictionary文件...", description: dictPathDesc },
			{ label: "$(bug) 管理INI Validator...", description: validatorDesc },
			{ label: "$(refresh) 重新索引工作区", description: "手动强制刷新所有文件的索引" },
			{ label: "$(json) 打开插件设置 (JSON)", description: "查看所有高级配置" },
		];
		
		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: "INI IntelliSense 主菜单"
		});

		if (!selection) {return;}

		if (selection.label.includes("设置向导")) {
			vscode.commands.executeCommand('ra2-ini-intellisense.showWelcomePage');
		} else if (selection.label.includes("Mod根目录")) {
			await configureModPath();
		} else if (selection.label.includes("INI Dictionary")) {
			vscode.commands.executeCommand('ra2-ini-intellisense.configureSchemaPath');
		} else if (selection.label.includes("INI Validator")) {
			iniValidator.showQuickPick();
		} else if (selection.label.includes("重新索引")) {
			// 这里使用 await 以便用户能感知到操作已完成
			await indexWorkspaceFiles();
			vscode.window.showInformationMessage("工作区已重新索引。");
		} else if (selection.label.includes("插件设置")) {
			vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense');
		}
	}));


	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.jumpToOverride', async (args) => {
		const { uri, position } = args;
		const targetUri = vscode.Uri.parse(uri);
		const targetPosition = new vscode.Position(position.line, position.character);
		
		const document = await vscode.workspace.openTextDocument(targetUri);
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(targetPosition, targetPosition);
		editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
	}));

	// 立即更新一次UI状态，显示初始状态
	updateMainStatus();
	// 开始加载Schema和索引文件，但不阻塞激活流程
	loadSchemaFromConfiguration().then(() => {
		overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
	});

	let codeLensProvider: vscode.Disposable | undefined;
	function updateCodeLensProvider() {
		const isEnabled = vscode.workspace.getConfiguration('ra2-ini-intellisense').get('codeLens.enabled');
		if (isEnabled) {
			if (!codeLensProvider) {
				codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
					provideCodeLenses(document, token) {
						if (isIndexing) { return []; } // 索引期间不提供 CodeLens
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
									parts.push(localize('codelens.references', '{0} references', valueRefs.length));
								}
								if (inheritanceRefs.length > 0) {
									parts.push(localize('codelens.inheritors', '{0} inheritors', inheritanceRefs.length));
								}
		
								let title: string;
								if (parts.length > 0) {
									title = parts.join(', ');
								} else {
									title = localize('codelens.noReferences', '0 references (potentially unused)');
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
		if (e.affectsConfiguration('ra2-ini-intellisense')) {
			// 配置变更后，重新加载 schema 并触发重新索引
			loadSchemaFromConfiguration().then(() => {
				updateMainStatus();
				if (e.affectsConfiguration('ra2-ini-intellisense.codeLens.enabled')) {
					updateCodeLensProvider();
				}
				if (e.affectsConfiguration('ra2-ini-intellisense.decorations')) {
					overrideDecorator.reload();
				}
				
				vscode.workspace.textDocuments.forEach(doc => triggerUpdateDiagnostics(doc));
				overrideDecorator.triggerUpdateDecorationsForAllVisibleEditors();
			});
		}
	}));
	updateCodeLensProvider();

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
	context.subscriptions.push(watcher);
	
	const onFileChange = async (uri: vscode.Uri) => {
		console.log(`INI 文件变更: ${uri.fsPath}, 正在增量更新索引...`);
		await iniManager.updateFile(uri);
		vscode.workspace.textDocuments.forEach(doc => {
			if (doc.languageId === LANGUAGE_ID) {
				triggerUpdateDiagnostics(doc);
				overrideDecorator.triggerUpdateDecorations(doc.uri);
			}
		});
		outlineProvider.refresh();
	};

	const onFileDelete = (uri: vscode.Uri) => {
		console.log(`INI 文件删除: ${uri.fsPath}, 正在移除索引...`);
		iniManager.removeFile(uri);
		vscode.workspace.textDocuments.forEach(doc => {
			if (doc.languageId === LANGUAGE_ID) {
				triggerUpdateDiagnostics(doc);
			}
		});
		outlineProvider.refresh();
	};

	watcher.onDidCreate(onFileChange);
	watcher.onDidChange(onFileChange);
	watcher.onDidDelete(onFileDelete);

	context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.showDebugInfo', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage(localize('debug.openFileFirst', 'Please open an INI file before running this command.'));
			return;
		}

		const position = editor.selection.active;
		const document = editor.document;
		
		outputChannel.clear();
		outputChannel.appendLine(localize('debug.title', '--- INI IntelliSense Debug Info ---\n'));

		const idListRegistryNames = schemaManager.getIdListRegistryNames();
		if (idListRegistryNames.size > 0) {
			outputChannel.appendLine(localize('debug.schema.loaded', '✅ Schema loaded: Found {0} registries in total.', schemaManager.getRegistryNames().size));
			outputChannel.appendLine(localize('debug.schema.idRegistriesFound', '✅ Identified {0} ID list registries for indexing:', idListRegistryNames.size));
			outputChannel.appendLine(`   ${Array.from(idListRegistryNames).join(', ')}`);
		} else {
			outputChannel.appendLine(localize('debug.schema.noIdRegistries', '❌ Warning: No ID list registries identified from the schema. Type inference will fail.'));
		}
		outputChannel.appendLine(localize('debug.index.summary', '✅ Indexing complete: Found {0} unique registered section IDs across all files.\n', iniManager.getRegistryMapSize()));

		outputChannel.appendLine(localize('debug.context.title', '--- Context Info ---'));
		outputChannel.appendLine(localize('debug.context.file', 'File: {0}', document.uri.fsPath));
		outputChannel.appendLine(localize('debug.context.position', 'Cursor Position: Line {0}, Character {1}\n', position.line + 1, position.character + 1));

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
			outputChannel.appendLine(localize('debug.context.noSection', 'Error: Cursor is not within a valid section.'));
			outputChannel.show();
			return;
		}
		
		outputChannel.appendLine(localize('debug.context.currentSection', '✅ Current Section: [{0}]', currentSectionName));

		const typeName = iniManager.getTypeForSection(currentSectionName);
		if (typeName) {
			outputChannel.appendLine(localize('debug.inference.success', "✅ Inferred Type: '{0}'", typeName));

			const debugLines = schemaManager.getDebugInfoForType(typeName);
			outputChannel.appendLine(localize('debug.analysis.title', '\n--- Type Inheritance & Key Analysis ---'));
			debugLines.forEach(line => outputChannel.appendLine(line));

			const allKeys = schemaManager.getAllKeysForType(typeName);
			if (allKeys.size > 0) {
				outputChannel.appendLine(localize('debug.analysis.totalKeys', '\n✅ Total available keys (including inherited): {0}', allKeys.size));
			} else {
				outputChannel.appendLine(localize('debug.analysis.noKeys', `\n❌ Warning: No keys found for type '{0}' after analyzing inheritance chain.`, typeName));
			}
		} else {
			outputChannel.appendLine(localize('debug.inference.failure', '\n❌ Error: Could not determine the type to analyze.'));
		}
		
		outputChannel.show();
	}));

	const diagnosticDebounceTimers = new Map<string, NodeJS.Timeout>();

	const triggerUpdateDiagnostics = (document: vscode.TextDocument) => {
		if (isIndexing) { return; } // 索引期间不进行诊断
		const documentUriString = document.uri.toString();
		if (diagnosticDebounceTimers.has(documentUriString)) {
			clearTimeout(diagnosticDebounceTimers.get(documentUriString)!);
		}

		diagnosticDebounceTimers.set(documentUriString, setTimeout(() => {
			diagnosticDebounceTimers.delete(documentUriString);
			setTimeout(() => updateDiagnostics(document), 0);
		}, 300));
	};

    const updateDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== LANGUAGE_ID || document.isClosed) {
            return;
        }

        isDiagnosing = true;
        updateMainStatus(); 

        try {
            const config = vscode.workspace.getConfiguration('ra2-ini-intellisense.diagnostics');
            
            // 显式转换为字符串数组，防止 Set 中混入非字符串类型导致匹配失败
            const rawDisableConfig = config.get<string[]>('disable', []);
            const disabledErrorCodes = new Set<string>(rawDisableConfig.map(c => String(c)));

            const context = {
                document,
                schemaManager,
                iniManager,
                config,
                disabledErrorCodes,
                outputChannel // 传递输出通道
            };

            await new Promise(resolve => setTimeout(resolve, 0));
            
            const externalDiagnostics = (diagnostics.get(document.uri) || []).filter(d => d.source === 'INI Validator');
            const internalDiagnostics = diagnosticEngine.analyze(context);

            diagnostics.set(document.uri, [...externalDiagnostics, ...internalDiagnostics]);
        } catch (e) {
            console.error(e);
            outputChannel.appendLine(`[Error] Diagnostic failed: ${e}`);
        } finally {
            isDiagnosing = false;
            updateMainStatus(); 
        }
    };

    vscode.workspace.onDidChangeTextDocument(async event => {
		if (event.document.languageId === LANGUAGE_ID) {
			await iniManager.updateFile(event.document.uri, event.document.getText());
			triggerUpdateDiagnostics(event.document);
		}
	});

    vscode.workspace.onDidOpenTextDocument(document => {
		if (document.languageId === LANGUAGE_ID) {
			iniManager.updateFile(document.uri, document.getText()).then(() => {
				triggerUpdateDiagnostics(document);
			});
		}
	});
    vscode.workspace.onDidCloseTextDocument(document => {
		diagnostics.delete(document.uri);
	});

    vscode.workspace.textDocuments.forEach(doc => {
		if (doc.languageId === LANGUAGE_ID) {
			triggerUpdateDiagnostics(doc);
		}
	});

	context.subscriptions.push(
		vscode.languages.registerRenameProvider(selector, new IniRenameProvider(iniManager)),
		vscode.languages.registerCodeActionsProvider(selector, new IniCodeActionProvider(iniManager, schemaManager), {
			providedCodeActionKinds: IniCodeActionProvider.providedCodeActionKinds
		})
	);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(selector, {
			async provideDefinition(document, position, token) {
				if (isIndexing) { return []; }
				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
				if (!wordRange) {
					return [];
				}
				const word = document.getText(wordRange);

				const lineInCurrentFile = iniManager.findSectionInContent(document.getText(), word);
				if (lineInCurrentFile !== null) {
					return new vscode.Location(document.uri, new vscode.Position(lineInCurrentFile, 0));
				}
				
				const sectionLocations = iniManager.findSectionLocations(word);
				if (sectionLocations.length > 0) {
					return sectionLocations;
				}
				
				return [];
			}
		}),
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				if (isIndexing) { return null; }
				const line = document.lineAt(position.line);
				const lineText = line.text;
				const equalsIndex = lineText.indexOf('=');

				if (equalsIndex === -1) { 
					const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.-]+/);
					if (!wordRange) {return null;}

					const word = document.getText(wordRange);
					const sectionInfos = iniManager.findSection(word);
					if (sectionInfos.length > 0) {
						const commentText = iniManager.getSectionComment(sectionInfos[0].content, word);
						if (commentText) {
							return new vscode.Hover(new vscode.MarkdownString(commentText), wordRange);
						}
					}
					return null;
				}

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
						markdown.appendMarkdown(localize('hover.type.belongsTo', `Belongs to type **{0}**.`, typeName));
						hasContent = true;
					}
				}

				const parentName = iniManager.getInheritance(currentSectionName);
				if (parentName) {
					const parentTypeName = iniManager.getTypeForSection(parentName);
					const parentKeys = schemaManager.getAllKeysForType(parentTypeName);

					if (parentKeys.has(keyPart)) {
						const parentKeyInfo = iniManager.findKeyLocationRecursive(parentName, keyPart); 
					
						if (parentKeyInfo && parentKeyInfo.location && parentKeyInfo.lineText && parentKeyInfo.definer) {
							if(hasContent) {markdown.appendMarkdown('\n\n---\n\n');}

							const lineNum = parentKeyInfo.location.range.start.line + 1;
							const fileName = path.basename(parentKeyInfo.location.uri.fsPath);

							markdown.appendMarkdown(localize('hover.override.info', `This key overrides a value from base class in **{0}**:L{1}`, fileName, lineNum));
							
							const parentValueMatch = parentKeyInfo.lineText.match(/=\s*(.*)/);
							const parentValueRaw = parentValueMatch ? parentValueMatch[1].trim() : '';
							const parentValue = parentValueRaw.split(';')[0].trim();

							markdown.appendCodeblock(`[${parentKeyInfo.definer}]\n${keyPart}=${parentValue || ''}`, 'ini');

							const args = {
								uri: parentKeyInfo.location.uri.toString(),
								position: parentKeyInfo.location.range.start
							};
							const commandUri = vscode.Uri.parse(`command:ra2-ini-intellisense.jumpToOverride?${encodeURIComponent(JSON.stringify(args))}`);
							markdown.appendMarkdown(localize('hover.override.jumpLink', `[$(go-to-file) Go to Parent Definition]({0})`, commandUri.toString()));
							hasContent = true;
						}
					}
				}

				return hasContent ? new vscode.Hover(markdown, keyRange) : null;
			}
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			async provideCompletionItems(document, position, token, context) {
				if (isIndexing) { return new vscode.CompletionList([], true); }
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
							item.documentation = localize('completion.color.documentation', 'Enter an RGB color value, e.g., 255,0,0');
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
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document, token) {
				if (isIndexing) { return []; }
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
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences(document, position, context, token) {
				if (isIndexing) { return []; }
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

	// 在扩展激活后，检查并提示进行初始配置
	async function promptForInitialSetup() {
		const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
		const projectRoot = getProjectRoot();
        const dictPath = config.get<string>('schemaFilePath');
		const dontAsk = config.get<boolean>('dontAskToConfigureProject');

		if ((!projectRoot || !dictPath) && !dontAsk) {
            const openWizardAction = localize('prompt.configureII.action.welcome', 'Open Setup Guide');
			const dontAskAction = localize('prompt.configureII.action.dontAsk', "Don't Ask Again");
            
            let message: string;
            let quickAction: string | undefined;

            if (!projectRoot) {
                message = localize('prompt.configureII.message.root', 'Welcome to INI IntelliSense! Please set your Mod project root directory to enable all features.');
            } else {
                // 如果只缺字典，提供一键自动配置
                message = localize('prompt.configureII.message.dict', 'INI Dictionary is missing. Would you like to download and configure it automatically?');
                quickAction = localize('prompt.configureII.action.autoConfig', 'Auto Configure');
            }

            const items = quickAction ? [quickAction, openWizardAction, dontAskAction] : [openWizardAction, dontAskAction];
			const selection = await vscode.window.showInformationMessage(message, ...items);

            if (selection === quickAction && quickAction) {
                // 调用服务进行下载
                await dictionaryService.downloadAndConfigure();
                
                await loadSchemaFromConfiguration(); 
                updateMainStatus();
            } else if (selection === openWizardAction) {
				vscode.commands.executeCommand('ra2-ini-intellisense.showWelcomePage');
			} else if (selection === dontAskAction) {
				await config.update('dontAskToConfigureProject', true, vscode.ConfigurationTarget.Workspace);
			}
		}
	}

	// 在激活流程的最后调用这个函数
	promptForInitialSetup();

}

/**
 * 扩展的停用函数，用于清理资源。
 */
export function deactivate() {
	diagnostics.dispose();
}