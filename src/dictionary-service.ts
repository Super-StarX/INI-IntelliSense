import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { localize } from './i18n';

const DICT_URL = 'https://raw.githubusercontent.com/Starry-Orbit-Studio/RA2-INI-Dictionary/main/INIDictionary.ini';
const DICT_FILENAME = 'INIDictionary.ini';

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
            try {
                // 获取 Buffer 数据
                const contentBuffer = await this.httpsGet(DICT_URL);
                // 直接写入 Buffer
                await fs.promises.writeFile(targetPath, contentBuffer);
                
                const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
                
                const inspect = config.inspect('schemaFilePath');
                if (inspect?.workspaceValue !== undefined) {
                    await config.update('schemaFilePath', undefined, vscode.ConfigurationTarget.Workspace);
                }

                await config.update('schemaFilePath', targetPath, vscode.ConfigurationTarget.Global);
                
                vscode.window.showInformationMessage(localize('dictionary.download.success', 'INI Dictionary downloaded and configured successfully.'));
                return targetPath;
            } catch (error: any) {
                vscode.window.showErrorMessage(localize('dictionary.download.failed', 'Failed to download dictionary: {0}', error.message));
                throw error;
            }
        });
    }

    private httpsGet(url: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Request failed with status code: ${res.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => { chunks.push(chunk); });
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', (err) => {
                reject(err);
            });
        });
    }
}