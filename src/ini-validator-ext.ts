import * as vscode from 'vscode';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs/promises';

type ValidatorStatus = 'ready' | 'invalid' | 'unconfigured';
const DOWNLOAD_URL = 'https://www.bilibili.com/opus/1022686010171981842';
const CONFIG_KEY_EXE_PATH = 'ra2-ini-intellisense.exePath';
const CONFIG_KEY_DONT_ASK = 'ra2-ini-intellisense.dontAskToConfigureValidator';

export class INIValidatorExt {

    private diagnostics: vscode.DiagnosticCollection;
    private statusBarItem: vscode.StatusBarItem;
    private status: ValidatorStatus = 'unconfigured';
    private exePath: string | undefined;

    constructor(diagnostics: vscode.DiagnosticCollection) {
        this.diagnostics = diagnostics;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        // 设置点击状态栏图标时要执行的命令
        this.statusBarItem.command = 'ra2-ini-intellisense.manageValidator';
    }

    /**
     * 初始化验证器,检查配置,设置监听器和状态栏
     */
    public async initialize(context: vscode.ExtensionContext) {
        context.subscriptions.push(this.statusBarItem);

        // 监听配置变更,以便实时更新状态
        // 正确的代码
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration(CONFIG_KEY_EXE_PATH) || e.affectsConfiguration(CONFIG_KEY_DONT_ASK)) {
                await this.validatePath();
            }
        }));

        // 注册核心管理命令,点击状态栏时触发
        context.subscriptions.push(vscode.commands.registerCommand('ra2-ini-intellisense.manageValidator', () => {
            this.showManagementQuickPick();
        }));

        await this.validatePath();
        this.promptIfUnconfigured();
    }

    /**
     * 弹出文件对话框让用户选择.exe文件
     */
    private async promptToSelectExePath() {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: '选择 INIValidator.exe',
            // 根据操作系统类型,筛选.exe文件
            filters: process.platform === 'win32' ? { '可执行文件': ['exe'], '所有文件': ['*'] } : undefined
        };

        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
            const selectedPath = fileUri[0].fsPath;
            const config = vscode.workspace.getConfiguration();
            // 将用户选择的路径更新到全局配置中
            await config.update(CONFIG_KEY_EXE_PATH, selectedPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`INI Validator 路径已设置为: ${selectedPath}`);
            // **关键修复**: 手动更新配置后,立即重新验证路径并更新UI
            await this.validatePath();
        }
    }

    /**
     * 显示管理验证器的快速选择菜单
     */
    private async showManagementQuickPick() {
        const items: vscode.QuickPickItem[] = [];

        if (this.status === 'ready') {
            items.push({ label: "$(file-code) 更改 INI Validator 路径...", description: "选择一个新的 INIValidator.exe 文件" });
        } else {
            items.push({ label: "$(file-code) 选择 INI Validator 路径...", description: "配置 INIValidator.exe 的路径" });
        }

        items.push({ label: "$(cloud-download) 前往下载 INI Validator", description: "在浏览器中打开下载页面" });
        
        const config = vscode.workspace.getConfiguration();
        const dontAsk = config.get<boolean>(CONFIG_KEY_DONT_ASK);
        if (!dontAsk) {
            items.push({ label: "$(bell-slash) 不再提示(启动时)", description: "停止在启动时请求配置验证器" });
        } else {
            items.push({ label: "$(bell-dot) 启用启动时提示", description: "下次启动时再次提示配置验证器" });
        }
        
        items.push({ label: "$(settings) 打开插件设置 (JSON)", description: "用于高级配置" });

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: '管理 INI Validator 集成'
        });

        if (!selection) return;

        if (selection.label.includes('选择') || selection.label.includes('更改')) {
            this.promptToSelectExePath();
        } else if (selection.label.includes('下载')) {
            vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
        } else if (selection.label.includes('不再提示')) {
            await config.update(CONFIG_KEY_DONT_ASK, true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("INI Validator 的启动提示已禁用。");
        } else if (selection.label.includes('启用启动时提示')) {
            await config.update(CONFIG_KEY_DONT_ASK, false, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("INI Validator 的启动提示已启用。");
        } else if (selection.label.includes('设置')) {
             vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_KEY_EXE_PATH);
        }
    }

    /**
     * 检查验证器路径是否有效,并更新内部状态和UI
     */
    private async validatePath() {
        const config = vscode.workspace.getConfiguration();
        let configuredPath = config.get<string>(CONFIG_KEY_EXE_PATH);

        if (!configuredPath) {
            this.updateStatus('unconfigured');
            return;
        }

        if (configuredPath.startsWith('~/')) {
            configuredPath = path.join(os.homedir(), configuredPath.slice(2));
        }
        
        this.exePath = path.resolve(configuredPath);

        try {
            const stats = await fs.stat(this.exePath);
            if (stats.isFile()) {
                if (process.platform !== 'win32') {
                    await fs.access(this.exePath, fs.constants.X_OK);
                }
                this.updateStatus('ready');
            } else {
                this.updateStatus('invalid', '路径指向的是一个目录, 而非文件。');
            }
        } catch (error) {
            this.updateStatus('invalid', '路径不存在或无法访问。');
        }
    }

    /**
     * 更新验证器状态并刷新状态栏UI
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
     * 如果未配置验证器,则向用户发出提示
     */
    private async promptIfUnconfigured() {
        if (this.status === 'unconfigured') {
            const config = vscode.workspace.getConfiguration();
            const dontAsk = config.get<boolean>(CONFIG_KEY_DONT_ASK);
            
            if (dontAsk) {
                return;
            }

            const selection = await vscode.window.showInformationMessage(
                '未配置 INI Validator, 是否设置以启用高级诊断功能?',
                '配置路径',
                '前往下载',
                "不再询问"
            );

            if (selection === '配置路径') {
                this.promptToSelectExePath();
            } else if (selection === '前往下载') {
                vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
            } else if (selection === "不再询问") {
                await config.update(CONFIG_KEY_DONT_ASK, true, vscode.ConfigurationTarget.Global);
            }
        }
    }

    public isReady(): boolean {
        return this.status === 'ready';
    }

    /**
     * 异步调用外部验证器并处理其输出
     */
    public async runValidation(files: string[]) {
        if (!this.isReady() || !this.exePath) {
            return;
        }

        const exeDir = path.dirname(this.exePath);
        const command = `"${this.exePath}" ${files.map(f => `"${f}"`).join(' ')}`;
        
        try {
            await this.executeCommand(command, { cwd: exeDir });

            const resultPath = path.join(exeDir, "Checker.json");
            const resultsJson = await fs.readFile(resultPath, 'utf8');
            const results = JSON.parse(resultsJson);

            if (Array.isArray(results)) {
                this.processValidationResults(results);
            }
        } catch (error) {
            vscode.window.showErrorMessage('运行 INI Validator 失败, 请检查路径和文件权限。');
            console.error('INI Validator 执行错误:', error);
        }
    }

    /**
     * 将验证结果转换为VS Code诊断信息
     */
    private async processValidationResults(results: any[]) {
        this.diagnostics.clear();
        const diagnosticsByFile: Map<string, vscode.Diagnostic[]> = new Map();

        for (const error of results) {
            if (!error.filename || error.line === undefined || !error.message) continue;

            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(error.line, 0, error.line, Number.MAX_VALUE),
                error.message,
                this.toDiagnosticSeverity(error.level)
            );
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
     * 将错误级别字符串转换为VS Code的DiagnosticSeverity
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
     * 将 child_process.exec 包装成 Promise
     */
    private executeCommand(command: string, options: cp.ExecOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (stderr) {
                    console.warn('INI Validator 在 stderr 产生了输出:', stderr);
                }
                resolve(stdout);
            });
        });
    }
}