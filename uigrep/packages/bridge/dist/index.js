import { captureManifestSchema, captureSessionSchema } from '@uigrep/schema';
export const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:47831';
export const AUTH_HEADER = 'x-uigrep-token';
export class UigrepDaemonClient {
    token;
    origin;
    constructor(token, origin = DEFAULT_DAEMON_ORIGIN) {
        this.token = token;
        this.origin = origin;
    }
    async health() {
        const response = await this.request('/v1/health');
        return response.ok;
    }
    async createCapture(capture) {
        const body = JSON.stringify(captureSessionSchema.parse(capture));
        const response = await this.request('/v1/captures', { method: 'POST', body });
        if (!response.ok)
            throw new Error(`Unable to store capture: ${response.status}`);
    }
    async listCaptures() {
        const response = await this.request('/v1/captures');
        if (!response.ok)
            throw new Error(`Unable to list captures: ${response.status}`);
        return captureManifestSchema.array().parse(await response.json());
    }
    async getCapture(id) {
        const response = await this.request(`/v1/captures/${encodeURIComponent(id)}`);
        if (!response.ok)
            throw new Error(`Unable to read capture: ${response.status}`);
        return captureSessionSchema.parse(await response.json());
    }
    request(path, init = {}) {
        const headers = new Headers(init.headers);
        headers.set(AUTH_HEADER, this.token);
        if (init.body)
            headers.set('content-type', 'application/json');
        return fetch(`${this.origin}${path}`, { ...init, headers });
    }
}
//# sourceMappingURL=index.js.map