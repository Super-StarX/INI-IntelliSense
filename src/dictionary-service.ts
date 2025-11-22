import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { localize } from './i18n';

const DICT_FILENAME = 'INIDictionary.ini';
// 定义主源和备用源列表
const DOWNLOAD_BASE_URLS = [
    'https://raw.githubusercontent.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/',
    'https://cdn.jsdelivr.net/gh/Starry-Orbit-Studio/RA2-INI-Dictionary@main/', 
    'https://fastly.jsdelivr.net/gh/Starry-Orbit-Studio/RA2-INI-Dictionary@main/', // jsDelivr CDN
    'https://raw.gitmirror.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/', // GitMirror
];

export class DictionaryService {
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 递归下载字典及其依赖。
     */
    public async downloadAndConfigure(): Promise<string> {
        const globalStoragePath = this.context.globalStorageUri.fsPath;
        
        // 使用专门的子目录来存放字典，保持整洁
        const dictDir = path.join(globalStoragePath, 'dictionary');
        if (!fs.existsSync(dictDir)) {
            fs.mkdirSync(dictDir, { recursive: true });
        }

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('dictionary.downloading', 'Downloading INI Dictionary...'),
            cancellable: false
        }, async (progress) => {
            let lastError: Error | null = null;

            // 外层循环：尝试不同的镜像源
            for (const baseUrl of DOWNLOAD_BASE_URLS) {
                try {
                    progress.report({ message: `Connecting to ${new URL(baseUrl).hostname}...` });
                    
                    // 递归下载所有依赖文件
                    // 初始队列只包含入口文件
                    const downloadQueue: string[] = [DICT_FILENAME];
                    const downloadedFiles = new Set<string>();

                    while (downloadQueue.length > 0) {
                        const filename = downloadQueue.shift()!;
                        if (downloadedFiles.has(filename)) { continue; }

                        progress.report({ message: `Downloading ${filename}...` });
                        
                        // 下载文件内容
                        const content = await this.httpsGet(baseUrl + filename);
                        
                        // 写入本地磁盘
                        await fs.promises.writeFile(path.join(dictDir, filename), Buffer.from(content));
                        downloadedFiles.add(filename);

                        // 极速扫描 [#include] 节以发现新文件
                        const lines = content.split(/\r?\n/);
                        let inInclude = false;
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.toLowerCase() === '[#include]') {
                                inInclude = true;
                                continue;
                            }
                            if (trimmed.startsWith('[')) {
                                inInclude = false;
                                continue;
                            }
                            
                            // 解析 include 内容：可能是 "3=Kratos.ini" 或 "Kratos.ini"
                            if (inInclude && trimmed && !trimmed.startsWith(';')) {
                                let nextFile = trimmed;
                                const eqIdx = trimmed.indexOf('=');
                                if (eqIdx !== -1) {
                                    nextFile = trimmed.substring(eqIdx + 1).trim();
                                }
                                // 如果发现了新文件且未下载过，加入队列
                                if (nextFile && !downloadedFiles.has(nextFile)) {
                                    downloadQueue.push(nextFile);
                                }
                            }
                        }
                    }
                    
                    // 如果执行到这里没有抛错，说明该镜像源下载成功
                    // 更新配置并返回
                    const targetPath = path.join(dictDir, DICT_FILENAME);
                    const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
                    
                    // 更新 workspace 设置（如果存在）以避免冲突
                    const inspect = config.inspect('schemaFilePath');
                    if (inspect?.workspaceValue !== undefined) {
                        await config.update('schemaFilePath', undefined, vscode.ConfigurationTarget.Workspace);
                    }
                    // 更新全局设置
                    await config.update('schemaFilePath', targetPath, vscode.ConfigurationTarget.Global);
                    
                    vscode.window.showInformationMessage(localize('dictionary.download.success', 'INI Dictionary downloaded and configured successfully.'));
                    return targetPath;

                } catch (error: any) {
                    console.warn(`Failed to download from ${baseUrl}: ${error.message}`);
                    lastError = error;
                    // 失败则尝试下一个 Base URL
                }
            }

            // 所有镜像源都失败
            const errorMessage = localize('dictionary.download.failed', 'All download attempts failed. Last error: {0}', lastError?.message || 'Unknown error');
            vscode.window.showErrorMessage(errorMessage);
            throw lastError;
        });
    }

    private httpsGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = https.get(url, (res) => {
                if (res.statusCode !== 200 && res.statusCode !== 301 && res.statusCode !== 302) {
                    reject(new Error(`Request failed with status code: ${res.statusCode}`));
                    return;
                }
                
                // 处理重定向
                if (res.statusCode === 301 || res.statusCode === 302) {
                    if (res.headers.location) {
                        this.httpsGet(res.headers.location).then(resolve).catch(reject);
                        return;
                    }
                }

                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            
            req.on('error', (err) => {
                reject(err);
            });
            
            // 设置超时，防止卡死
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }
}