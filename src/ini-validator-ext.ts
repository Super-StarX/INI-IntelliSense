import * as vscode from 'vscode';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs/promises';

type ValidatorStatus = 'ready' | 'invalid' | 'unconfigured';
const DOWNLOAD_URL = 'https://www.bilibili.com/opus/1022686010171981842';
const CONFIG_SECTION = 'ra2-ini-intellisense';
const CONFIG_KEY_EXE_PATH = 'ra2-ini-intellisense.exePath';
const CONFIG_KEY_FOLDER_PATH = 'ra2-ini-intellisense.validationFolderPath';
const CONFIG_KEY_FILES = 'ra2-ini-intellisense.validationFiles';
const CONFIG_KEY_DONT_ASK = 'ra2-ini-intellisense.dontAskToConfigureValidator';

/**
 * 封装与 INIValidator.exe 交互的所有逻辑
 */
export class INIValidatorExt {

    private diagnostics: vscode.DiagnosticCollection;
    private statusBarItem: vscode.StatusBarItem;
    private status: ValidatorStatus = 'unconfigured';
    private exePath: string | undefined;

    constructor(diagnostics: vscode.DiagnosticCollection) {
        this.diagnostics = diagnostics;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'ra2-ini-intellisense.manageValidator';
    }

    /**
     * 初始化验证器, 检查配置, 设置监听器和状态栏
     * @param context 扩展上下文
     */
    public async initialize(context: vscode.ExtensionContext) {
        context.subscriptions.push(this.statusBarItem);

        // 监听配置变更, 以便实时更新状态
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                await this.validatePath();
            }
        }));

        // 注册核心管理命令, 点击状态栏时触发
        context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.manageValidator', () => {
            this.showManagementQuickPick();
        }));

        // 注册手动执行校验的命令
        context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.runValidator', () => {
            this.runValidatorCommand();
        }));

        await this.validatePath();
        this.promptIfUnconfigured();
    }

    /**
     * 弹出文件对话框让用户选择 .exe 文件
     */
    private async promptToSelectExePath() {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: '选择 INIValidator.exe',
            filters: process.platform === 'win32' ? { '可执行文件': ['exe'], '所有文件': ['*'] } : undefined
        };
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
            await vscode.workspace.getConfiguration().update(CONFIG_KEY_EXE_PATH, fileUri[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`INI Validator 路径已设置为: ${fileUri[0].fsPath}`);
        }
    }

    /**
     * 弹出文件夹选择对话框让用户选择 Mod 根目录
     */
    private async promptToSelectModFolder() {
        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择 Mod 根目录'
        };
        const folderUri = await vscode.window.showOpenDialog(options);
        if (folderUri && folderUri[0]) {
            await vscode.workspace.getConfiguration().update(CONFIG_KEY_FOLDER_PATH, folderUri[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Mod 校验根目录已设置为: ${folderUri[0].fsPath}`);
        }
    }
    
    /**
     * 显示一个交互式菜单来管理要校验的文件列表
     */
    private async manageValidationFiles() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        let files = config.get<{[key: string]: string}>('validationFiles', {});

        const toQuickPickItem = (key: string, value: string): vscode.QuickPickItem => ({
            label: `[${key}] = ${value}`,
            description: '点击以编辑或删除此条目'
        });

        // 构造菜单项, 包括 "添加" 和所有现有条目
        const items: vscode.QuickPickItem[] = [
            { label: '$(add) 添加新文件条目...', description: '为 [Files] 节添加一个新的键值对' },
            ...Object.entries(files).map(([key, value]) => toQuickPickItem(key, value))
        ];

        const selection = await vscode.window.showQuickPick(items, { placeHolder: '管理要校验的文件列表' });
        if (!selection) {
            return;
        }

        if (selection.label.startsWith('$(add)')) {
            // 添加新条目
            const key = await vscode.window.showInputBox({ prompt: '输入键名 (例如: rulesext)' });
            if (!key) {
                return;
            }
            const value = await vscode.window.showInputBox({ prompt: `输入 '${key}' 对应的文件名 (例如: rulesext.ini)` });
            if (value === undefined) {
                return;
            }
            files[key] = value;
        } else {
            // 编辑或删除现有条目
            const [key] = selection.label.substring(1).split(']')[0];
            const action = await vscode.window.showQuickPick(['编辑值', '删除条目'], { placeHolder: `操作 "${selection.label}"` });
            if (!action) {
                return;
            }

            if (action === '编辑值') {
                const newValue = await vscode.window.showInputBox({ prompt: `为键 '${key}' 输入新的文件名`, value: files[key] });
                if (newValue !== undefined) {
                    files[key] = newValue;
                }
            } else if (action === '删除条目') {
                delete files[key];
            }
        }
        await config.update('validationFiles', files, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('校验文件列表已更新。');
    }

    /**
     * 显示管理验证器的快速选择菜单
     */
    private async showManagementQuickPick() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const items: vscode.QuickPickItem[] = [];
        
        items.push({ label: "$(file-code) 设置 INI Validator 路径...", description: this.exePath || "当前未设置" });
        items.push({ label: "$(folder) 设置 Mod 根目录...", description: config.get('validationFolderPath') || "当前未设置" });
        items.push({ label: "$(list-selection) 编辑校验文件列表...", description: "交互式管理要校验的文件" });
        items.push({ label: "$(play) 手动执行一次校验", description: "立即生成Settings.ini并运行校验" });
        items.push({ label: "$(cloud-download) 前往下载 INI Validator", description: "在浏览器中打开下载页面" });
        items.push({ label: "$(settings) 打开插件设置 (JSON)", description: "用于高级配置" });

        const selection = await vscode.window.showQuickPick(items, { placeHolder: '管理 INI Validator 集成' });
        if (!selection) {
            return;
        }

        if (selection.label.startsWith('$(file-code)')) {
            this.promptToSelectExePath();
        } else if (selection.label.startsWith('$(folder)')) {
            this.promptToSelectModFolder();
        } else if (selection.label.startsWith('$(list-selection)')) {
            this.manageValidationFiles();
        } else if (selection.label.startsWith('$(play)')) {
            vscode.commands.executeCommand('ra2-ini-intellisense.runValidator');
        } else if (selection.label.startsWith('$(cloud-download)')) {
            vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
        } else if (selection.label.startsWith('$(settings)')) {
            vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
        }
    }

    /**
     * 检查验证器路径是否有效, 并更新内部状态和UI
     */
    private async validatePath() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        let configuredPath = config.get<string>('exePath'); // 修复: 使用相对键
        if (!configuredPath) {
            this.updateStatus('unconfigured'); return;
        }
        this.exePath = path.resolve(configuredPath.startsWith('~/') ? path.join(os.homedir(), configuredPath.slice(2)) : configuredPath);
        try {
            const stats = await fs.stat(this.exePath);
            this.updateStatus(stats.isFile() ? 'ready' : 'invalid', stats.isFile() ? '' : '路径指向的是一个目录, 而非文件。');
        } catch (error) {
            this.updateStatus('invalid', '路径不存在或无法访问。');
        }
    }

    /**
     * 更新验证器状态并刷新状态栏UI
     * @param status 新的状态
     * @param details 附加信息, 用于悬停提示
     */
    private updateStatus(status: ValidatorStatus, details: string = '') {
        this.status = status;
        switch (status) {
            case 'ready':
                this.statusBarItem.text = `$(check) INI Validator`;
                this.statusBarItem.tooltip = `准备就绪: ${this.exePath}\n点击进行管理。`;
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'invalid':
                this.statusBarItem.text = `$(error) INI Validator`;
                this.statusBarItem.tooltip = `错误: 配置的路径无效, 点击修复。\n详情: ${details}`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            case 'unconfigured':
                this.statusBarItem.text = `$(warning) INI Validator`;
                this.statusBarItem.tooltip = '未配置, 点击进行设置。';
                this.statusBarItem.backgroundColor = undefined;
                break;
        }
        this.statusBarItem.show();
    }

    /**
     * 如果未配置验证器, 则向用户发出首次使用提示
     */
    private async promptIfUnconfigured() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const dontAsk = config.get<boolean>('dontAskToConfigureValidator'); // 修复: 使用相对键

        if (this.status === 'unconfigured' && !dontAsk) {
            const selection = await vscode.window.showInformationMessage('未配置 INI Validator, 是否设置以启用高级诊断功能?', '配置路径', '前往下载', "不再询问");
            if (selection === '配置路径') {
                this.promptToSelectExePath();
            } else if (selection === '前往下载') {
                vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
            } else if (selection === "不再询问") {
                await config.update('dontAskToConfigureValidator', true, vscode.ConfigurationTarget.Global); // 修复: 使用相对键
            }
        }
    }

    public isReady(): boolean {
        return this.status === 'ready';
    }

    /**
     * 作为命令独立执行校验流程, 并提供用户反馈
     */
    public async runValidatorCommand() {
        if (!this.isReady()) {
            vscode.window.showWarningMessage('INI Validator 尚未配置, 无法执行校验。');
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在运行 INI Validator...",
            cancellable: false
        }, async (progress) => {
            const success = await this.runValidation();
            if (success) {
                progress.report({ message: '校验完成!' });
            } else {
                progress.report({ message: '校验失败。' });
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
    }

    /**
     * 核心校验逻辑: 生成Settings.ini, 调用外部程序, 并处理结果
     * @returns 一个布尔值, 表示操作是否成功
     */
    public async runValidation(): Promise<boolean> {
        if (!this.isReady() || !this.exePath) {
            return false;
        }

        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const folderPath = config.get<string>('validationFolderPath'); // 修复: 使用相对键
        if (!folderPath) {
            vscode.window.showWarningMessage('未配置Mod校验根目录, 已跳过 INI Validator 校验。');
            return false;
        }

        const files = config.get<object>('validationFiles'); // 修复: 使用相对键
        const exeDir = path.dirname(this.exePath);
        const filesSectionContent = Object.entries(files || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        const settingsContent = `[INIValidator]\nFolderPath=${folderPath}\nJsonLog=true\n\n[Files]\n${filesSectionContent}\n`;

        try {
            const settingsIniPath = path.join(exeDir, 'Settings.ini');
            await fs.writeFile(settingsIniPath, settingsContent, 'utf-8');
            
            const command = `"${this.exePath}"`;
            await this.executeCommand(command, { cwd: exeDir });

            const resultPath = path.join(exeDir, "Checker.json");
            const resultsJson = await fs.readFile(resultPath, 'utf8');
            const results = JSON.parse(resultsJson);
            if (Array.isArray(results)) {
                this.processValidationResults(results);
            }
            return true;

        } catch (error: any) {
            const errorMessage = `运行 INI Validator 失败: ${error.message}。请检查路径、文件权限以及 '${path.basename(exeDir)}' 目录的写入权限。`;
            vscode.window.showErrorMessage(errorMessage);
            console.error('INI Validator 执行错误:', error);
            return false;
        }
    }
    
    /**
     * 将验证器返回的JSON结果转换为VS Code的诊断信息
     * @param results 从 Checker.json 读取到的结果数组
     */
    private async processValidationResults(results: any[]) {
        this.diagnostics.clear();
        const diagnosticsByFile: Map<string, vscode.Diagnostic[]> = new Map();
        for (const error of results) {
            if (!error.filename || error.line === undefined || !error.message) {
                continue;
            }
            // IV返回的行号可能是从1开始, VS Code需要从0开始
            const line = Math.max(0, error.line - 1);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_VALUE), error.message, this.toDiagnosticSeverity(error.level));
            diagnostic.source = 'INI Validator';
            if (!diagnosticsByFile.has(error.filename)) {
                diagnosticsByFile.set(error.filename, []);
            }
            diagnosticsByFile.get(error.filename)?.push(diagnostic);
        }
        for (const [fileName, fileDiagnostics] of diagnosticsByFile.entries()) {
            const fileUris = await vscode.workspace.findFiles('**/' + fileName, null, 1);
            if (fileUris.length > 0) {
                this.diagnostics.set(fileUris[0], fileDiagnostics);
            }
        }
    }

    /**
     * 将错误级别字符串转换为VS Code的DiagnosticSeverity枚举
     * @param level 错误级别字符串, 如 "错误", "warn"
     */
    private toDiagnosticSeverity(level: string): DiagnosticSeverity {
        switch (level) {
            case "错误": return DiagnosticSeverity.Error;
            case "warn": return DiagnosticSeverity.Warning;
            case "建议": return DiagnosticSeverity.Information;
            default: return DiagnosticSeverity.Hint;
        }
    }
    
    /**
     * 将 child_process.exec 包装成一个 Promise, 以便使用 async/await
     * @param command 要执行的完整命令字符串
     * @param options child_process.exec 的选项
     */
    private executeCommand(command: string, options: cp.ExecOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    reject(error); return;
                }
                if (stderr) {
                    console.warn('INI Validator 在 stderr 产生了输出:', stderr);
                }
                resolve(stdout);
            });
        });
    }
}