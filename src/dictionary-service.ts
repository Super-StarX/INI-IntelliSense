import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { localize } from './i18n';

const DICT_FILENAME = 'INIDictionary.ini';
// 定义主源和备用源列表
const DOWNLOAD_URLS = [
    'https://raw.githubusercontent.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/INIDictionary.ini',
    'https://fastly.jsdelivr.net/gh/Starry-Orbit-Studio/RA2-INI-Dictionary@main/INIDictionary.ini', // jsDelivr CDN
    'https://raw.gitmirror.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/INIDictionary.ini', // GitMirror
];

export class DictionaryService {
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 下载并配置字典到全局存储。
     * @returns 下载后的文件路径
     */
    public async downloadAndConfigure(): Promise<string> {
        const globalStoragePath = this.context.globalStorageUri.fsPath;
        
        if (!fs.existsSync(globalStoragePath)) {
            fs.mkdirSync(globalStoragePath, { recursive: true });
        }

        const targetPath = path.join(globalStoragePath, DICT_FILENAME);

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('dictionary.downloading', 'Downloading INI Dictionary...'),
            cancellable: false
        }, async (progress) => {
            let lastError: Error | null = null;

            // 尝试从列表中的每个 URL 下载
            for (const url of DOWNLOAD_URLS) {
                try {
                    progress.report({ message: `Connecting to ${new URL(url).hostname}...` });
                    const content = await this.httpsGet(url);
                    await fs.promises.writeFile(targetPath, Buffer.from(content));
                    
                    // 下载成功，更新配置
                    const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
                    const inspect = config.inspect('schemaFilePath');
                    if (inspect?.workspaceValue !== undefined) {
                        await config.update('schemaFilePath', undefined, vscode.ConfigurationTarget.Workspace);
                    }
                    await config.update('schemaFilePath', targetPath, vscode.ConfigurationTarget.Global);
                    
                    vscode.window.showInformationMessage(localize('dictionary.download.success', 'INI Dictionary downloaded and configured successfully.'));
                    return targetPath;
                } catch (error: any) {
                    console.warn(`Failed to download from ${url}: ${error.message}`);
                    lastError = error;
                    // 继续尝试下一个 URL
                }
            }

            // 如果所有 URL 都失败了
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