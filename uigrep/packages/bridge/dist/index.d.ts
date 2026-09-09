import { type CaptureManifest, type CaptureSession } from '@uigrep/schema';
export declare const DEFAULT_DAEMON_ORIGIN = "http://127.0.0.1:47831";
export declare const AUTH_HEADER = "x-uigrep-token";
export declare class UigrepDaemonClient {
    private readonly token;
    private readonly origin;
    constructor(token: string, origin?: string);
    health(): Promise<boolean>;
    createCapture(capture: CaptureSession): Promise<void>;
    listCaptures(): Promise<CaptureManifest[]>;
    getCapture(id: string): Promise<CaptureSession>;
    private request;
}
//# sourceMappingURL=index.d.ts.map