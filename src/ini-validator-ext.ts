import * as vscode from 'vscode';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

export class INIValidatorExt {

    constructor(diagnostics:vscode.DiagnosticCollection) {
        this.diagnostics = diagnostics;
    }

    private diagnostics: vscode.DiagnosticCollection;

    public registerCommand(){
        return vscode.commands.registerCommand('ra2-ini-intellisense.openSettings', () => {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'ra2-ini-intellisense.exePath'
            );
        });
    }

    /**
     * 更新IniValidator的exe路径配置
     * @returns 
     */
     public updateIniValidatorPath() {
        const config = vscode.workspace.getConfiguration('ra2-ini-intellisense');
        let exePath = config.get<string>('exePath');
    
        if (exePath && exePath.startsWith('~/')) {
            exePath = path.join(os.homedir(), exePath.slice(2));
        }
        if (exePath === undefined) {
            vscode.window.showErrorMessage('No executable path provided for INI Validator.','Open Settings').then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand(
                        'ra2-ini-intellisense.openSettings'
                    );
                }
            });
            return;
        }
    
        if (!this.validateExePath(exePath)) {
            vscode.window.showErrorMessage('Invalid or non-executable path provided for INI Validator.','Open Settings').then((selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand(
                        'ra2-ini-intellisense.openSettings'
                    );
                }
            }));
            return;
        }
    
        // 验证路径
        if (!this.validateExePath(exePath)) {
            vscode.window.showErrorMessage(
                'Invalid or non-executable path provided for INI Validator.',
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('ra2-ini-intellisense.openSettings');
                }
            });
            return;
        }else{
            vscode.window.showInformationMessage('INIValidator registered successfully');
        }
    }
    
    private validateExePath(exePath: string): boolean {
        try {
            // 解析并标准化路径，确保跨平台兼容性
            const resolvedPath = path.resolve(exePath);
    
            // 检查文件是否存在
            const stats = fs.statSync(resolvedPath);
    
            // 确认它是一个文件而不是目录
            if (!stats.isFile()) {
                return false;
            }
    
            // 检查文件是否具有执行权限
            // 注意：在 Windows 上，这个检查可能不完全可靠，因为 Windows 文件系统没有 Unix 那样的权限位。
            // 但是，对于 .exe 文件，通常可以假设它们是可执行的。
            if (process.platform !== 'win32') {
                try {
                    fs.accessSync(resolvedPath, fs.constants.X_OK);
                } catch {
                    return false;
                }
            }
    
            return true;
    
        } catch (err) {
            // 如果遇到任何错误（如路径不存在或无法访问），则认为验证失败
            return false;
        }
    }
    
    
    
     public async callIniValidator(file:string[]) {
        // 获取工作区根路径或当前打开文件的路径
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }
    
        // 构建 .exe 文件的完整路径
        let config = vscode.workspace.getConfiguration('ini-validator-for-ra2');
        let exePath = config.get<string>('exePath') || "";
        // const exePath = path.join(__dirname, '..', 'resources', 'your-executable.exe'); // 根据实际情况调整路径
        let exeDir = path.dirname(exePath);
    
        const options = {
            cwd: exeDir, // 设置为 .exe 所需的工作目录
            env: process.env // 使用当前进程的环境变量，或者自定义一个
        };
    
        var args = file;
        let command = `"${exePath}" ${args.join(' ')}`;
        // 调用外部 exe 文件
        try{
            cp.exec(command, options, (err, stdout, stderr) => {});
            var resultPath = exeDir + "/Checker.json";
            // const child = cp.spawn(exePath, args,options);
            this.checkFileCompletion(resultPath);
    
            var json = this.readFileSync(resultPath);
    
            var results:[{filename:string,line:number,section:string,level:string,message:string}] = JSON.parse(json);
            
            if(results){
                // 清理之前的诊断信息
                this.diagnostics.clear();
    
                // 按照 fileName 分组
                const groupedErrors = results.reduce((acc:any, error) => {
                    const { filename } = error;
                    if (!acc[filename]) {
                        acc[filename] = [];
                    }
                    acc[filename].push(error);
                    return acc;
                }, {});
    
                 // 遍历分组后的错误信息并添加诊断信息
                 for (const fileName in groupedErrors) {
                    const errors:[{filename:string,line:number,section:string,level:string,message:string}] = groupedErrors[fileName];
                    const arr = [];
                    for (const error of errors) {
                        const range = new vscode.Range(error.line, 0, error.line, Number.MAX_VALUE);
                        const diagnostic = new vscode.Diagnostic(range, error.message, this.ToDiagnosticSeverity(error.level));
                        arr.push(diagnostic);
                    }
    
                    const files = await vscode.workspace.findFiles('**/' + fileName); // 查找所有 .ini 文件
                    for (const file of files) {
                        const document = await vscode.workspace.openTextDocument(file);
                        this.diagnostics.set(document.uri, arr);
                    }
                }
            }
            
        }catch(err){
            vscode.window.showErrorMessage('Unexpected error when calling IniValidator.Please make sure [INIValidator]JsonLog=true is set in INICodingCheck.ini ');
            console.error(err);
        }
    }
    
    private readFileSync(filePath: string): string {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return content;
        } catch (err) {
            return '';
        }
    }
    
    private checkFileCompletion(outputPath: string) {
    
        // 定义一个函数来检查文件是否完成
        function isFileComplete(filePath: string): Promise<boolean> {
            return new Promise((resolve) => {
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        resolve(false);
                        return;
                    }
    
                    // 如果文件存在，检查文件大小是否稳定（即不再变化）
                    const fileSize = stats.size;
                    setTimeout(() => {
                        fs.stat(filePath, (err, updatedStats) => {
                            if (err) {
                                resolve(false);
                                return;
                            }
                            resolve(updatedStats.size === fileSize);
                        });
                    }, 500); // 等待 500ms 再检查文件大小
                });
            });
        }
    
        // 轮询检查文件是否完成
        async function pollFileCompletion() {
            while (true) {
                const isComplete = await isFileComplete(outputPath);
                if (isComplete) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // 每隔 1 秒检查一次
            }
        }
    
        pollFileCompletion();
    }
    
    private ToDiagnosticSeverity(type: string): DiagnosticSeverity {
        switch (type) {
            case "错误":
                return DiagnosticSeverity.Error;
            case "warn":
                return DiagnosticSeverity.Warning;
            case "建议":
                return DiagnosticSeverity.Information;
            default:
                return DiagnosticSeverity.Hint;
        }
    }
    
    
}