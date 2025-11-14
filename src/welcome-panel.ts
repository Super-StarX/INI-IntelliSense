import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

/**
 * 管理欢迎和设置向导的 Webview 面板
 */
export class WelcomePanel {
    public static currentPanel: WelcomePanel | undefined;
    public static readonly viewType = 'iniWelcome';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (WelcomePanel.currentPanel) {
            WelcomePanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            WelcomePanel.viewType,
            'INI IntelliSense 设置向导',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-ui')]
            }
        );

        WelcomePanel.currentPanel = new WelcomePanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this._disposables
        );
    }

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'selectModPath':
                this.selectModPath(message.useWorkspaceFolder);
                return;
            case 'downloadDictionary':
                this.downloadDictionary();
                return;
            case 'selectDictionary':
                this.selectDictionary();
                return;
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'ra2-ini-intellisense.indexing');
                return;
            case 'closeWelcome':
                this._panel.dispose();
                return;
        }
    }

    private async selectModPath(useWorkspaceFolder: boolean) {
        let folderPath: string | undefined;
        if (useWorkspaceFolder) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                vscode.window.showErrorMessage("当前没有打开的文件夹。请手动选择。");
                this._panel.webview.postMessage({ command: 'pathSelectionFailed' });
                return;
            }
        } else {
            const options: vscode.OpenDialogOptions = {
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: '选择 Mod 根目录'
            };
            const folderUri = await vscode.window.showOpenDialog(options);
            if (folderUri && folderUri[0]) {
                folderPath = folderUri[0].fsPath;
            }
        }

        if (folderPath) {
            await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('validationFolderPath', folderPath, vscode.ConfigurationTarget.Workspace);
            this._panel.webview.postMessage({ command: 'pathSelected', path: folderPath });
        } else {
            this._panel.webview.postMessage({ command: 'pathSelectionFailed' });
        }
    }

    private async downloadDictionary() {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("请先打开一个工作区文件夹以保存下载的文件。");
            this._panel.webview.postMessage({ command: 'downloadFailed', error: "No workspace folder open." });
            return;
        }
        
        const url = 'https://raw.githubusercontent.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/INIDictionary.ini';
        const targetDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.vscode');
        const targetPath = vscode.Uri.joinPath(targetDir, 'INIDictionary.ini');

        try {
            await vscode.workspace.fs.createDirectory(targetDir);
            
            const content = await this.httpsGet(url);
            await vscode.workspace.fs.writeFile(targetPath, Buffer.from(content));

            await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', targetPath.fsPath, vscode.ConfigurationTarget.Workspace);
            
            this._panel.webview.postMessage({ command: 'downloadFinished', path: targetPath.fsPath });
            vscode.window.showInformationMessage(`INI Dictionary 已成功下载并配置到: ${targetPath.fsPath}`);
        } catch (error: any) {
            this._panel.webview.postMessage({ command: 'downloadFailed', error: error.message });
            vscode.window.showErrorMessage(`下载 INI Dictionary 失败: ${error.message}`);
        }
    }

    private httpsGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`请求失败，状态码: ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    private async selectDictionary() {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: '选择 INI Dictionary 文件',
            filters: { 'INI 文件': ['ini'] }
        };
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri[0]) {
            const filePath = fileUri[0].fsPath;
            await vscode.workspace.getConfiguration('ra2-ini-intellisense').update('schemaFilePath', filePath, vscode.ConfigurationTarget.Workspace);
            this._panel.webview.postMessage({ command: 'dictionarySelected', path: filePath });
        } else {
             this._panel.webview.postMessage({ command: 'dictionarySelectionFailed' });
        }
    }

    public dispose() {
        WelcomePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'webview-ui', 'style.css'));
        
        const nonce = getNonce();
        const currentConfig = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        const defaultIncludes = JSON.stringify(currentConfig.get('indexing.includePatterns'), null, 2);

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>Welcome to INI IntelliSense</title>
			</head>
			<body>
                <div class="main-container">
                    <div class="left-panel">
                        <div class="brand-header animated">
                            <svg class="brand-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path fill="#00aaff" d="M50 0L61.2 38.8L100 50L61.2 61.2L50 100L38.8 61.2L0 50L38.8 38.8L50 0Z"/></svg>
                            <div class="brand-name">
                                <h2>星轨工作室</h2>
                                <p>Starry Orbit Studio</p>
                            </div>
                        </div>
                        <div class="info-module animated" style="animation-delay: 0.1s;">
                            <h3>欢迎来到INI Modding的新时代</h3>
                            <p><strong>INI IntelliSense</strong> 不仅仅是一个语法高亮工具。它是一个为《红色警戒2》Mod开发量身打造的、功能强大的 Visual Studio Code 扩展，旨在将现代IDE的强大功能带入古老的INI世界。由同样热爱Mod开发的我们——星轨工作室，倾力打造。</p>
                            <p>我们深知，INI配置的复杂性、代码间的隐性关联以及缺乏有效的错误检查，是长期困扰Mod开发者的痛点。本插件正是为了解决这些问题而生，它将成为您在Mod创作道路上最可靠的伙伴。</p>
                        </div>
                         <div class="info-module animated" style="animation-delay: 0.2s;">
                            <h3>核心功能亮点</h3>
                            <ul class="features-list">
                                <li>
                                    <span class="feature-icon">💡</span>
                                    <div class="feature-text"><strong>智能感知</strong><p>基于INI Dictionary的精确代码补全、类型检查和实时错误诊断，让您在编写时充满自信。</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🔗</span>
                                    <div class="feature-text"><strong>继承可视化</strong><p>清晰展示代码的覆盖关系，直观追溯父级定义，轻松驾驭复杂的继承结构。</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🔎</span>
                                    <div class="feature-text"><strong>全局跳转与引用</strong><p>Ctrl+点击，瞬间找到任何单位的定义。右键“查找所有引用”，全局追溯其使用情况。</p></div>
                                </li>
                                <li>
                                    <span class="feature-icon">🛡️</span>
                                    <div class="feature-text"><strong>深度逻辑校验</strong><p>与社区标准工具 <code>INIValidator.exe</code> 无缝集成，捕获那些仅靠语法检查无法发现的棘手逻辑错误。</p></div>
                                </li>
                            </ul>
                        </div>
                         <div class="info-module animated" style="animation-delay: 0.3s;">
                            <h3>我们对质量的承诺</h3>
                            <p>我们提供的 <strong>INI Dictionary</strong> 是一个由星轨工作室发起并维护的、持续更新的开源项目。它不是网络上某个过时的文件，而是我们对高质量开发工具承诺的一部分，确保您能获得最准确、最前沿的规则支持。</p>
                            <a href="https://github.com/Starry-Orbit-Studio/RA2-INI-Dictionary" class="github-button" title="为INI Dictionary做出贡献">
                                <svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                                欢迎贡献
                            </a>
                        </div>
                    </div>
                    <div class="right-panel">
                        <header class="header animated" style="animation-delay: 0.4s;">
                            <h1>配置向导</h1>
                            <p class="subtitle">让我们为您的项目激活全部潜能</p>
                        </header>
                        
                        <div class="progress-stepper animated" style="animation-delay: 0.5s;">
                           <div class="progress-node" id="progress-node-1"><div class="node-circle"><span>1</span></div><div class="node-label">项目目录</div></div>
                           <div class="progress-node" id="progress-node-2"><div class="node-circle"><span>2</span></div><div class="node-label">INI字典</div></div>
                           <div class="progress-node" id="progress-node-3"><div class="node-circle"><span>🎉</span></div><div class="node-label">完成</div></div>
                        </div>

                        <div class="steps-container">
                            <div id="step1" class="step-module animated" style="animation-delay: 0.6s;">
                                <div class="step-header">
                                    <h2 class="step-title">配置项目目录 (必需)</h2>
                                    <button class="redo-btn" data-step="1">重置</button>
                                </div>
                                <p class="step-description">设定您的Mod项目根目录。这是所有智能分析的起点。</p>
                                <div class="actions">
                                    <button id="use-workspace-btn" class="button-primary">
                                        <span>📁</span> 使用当前工作区
                                    </button>
                                    <button id="browse-folder-btn">
                                        <span>🔍</span> 手动浏览...
                                    </button>
                                </div>
                                <p class="result"></p>
                            </div>

                            <div id="step2" class="step-module animated" style="animation-delay: 0.7s;">
                                <div class="step-header">
                                    <h2 class="step-title">配置INI字典</h2>
                                     <button class="redo-btn" data-step="2">重置</button>
                                </div>
                                <p class="step-description">注入官方INI Dictionary，为代码补全与错误检查提供动力。</p>
                                <div class="actions">
                                    <button id="download-dict-btn" class="button-primary">
                                       <span>☁️</span> 自动下载与配置
                                    </button>
                                    <button id="select-dict-btn">
                                        <span>📄</span> 使用本地字典...
                                    </button>
                                </div>
                                <p class="result"></p>
                            </div>

                            <div id="step3" class="step-module animated" style="animation-delay: 0.8s;">
                                <div class="step-header">
                                    <h2 class="step-title">配置检测白名单</h2>
                                    <button class="redo-btn" data-step="3">重置</button>
                                </div>
                                <p class="step-description">定义插件需要关注的文件。当前默认规则如下：</p>
                                <pre><code>${defaultIncludes}</code></pre>
                                <div class="actions">
                                    <button id="use-default-indexing-btn">
                                        <span>👍</span> 接受默认
                                    </button>
                                    <button id="customize-indexing-btn">
                                        <span>⚙️</span> 我要自定义...
                                    </button>
                                </div>
                                <p class="result"></p>
                            </div>
                        </div>

                        <div class="finish-button-container animated" style="animation-delay: 0.9s;">
                            <button id="finish-btn">
                                <span>完成配置并关闭</span>
                            </button>
                        </div>
                    </div>
                </div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}