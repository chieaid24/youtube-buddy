import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('extension member API', () => {
	beforeAll(async () => {
		Object.assign(globalThis, {
			window: globalThis,
			chrome: {
				storage: {
					local: {
						get: vi.fn(),
						set: vi.fn(),
					},
				},
			},
		});
		await import('../../extension/shared.js');
	});

	it('deletes the complete member through DELETE /member', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal('fetch', fetchMock);

		const result = await window.YTB.deleteMember('silly-otters', 'a1b2c3d4');

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/member?code=silly-otters&clientId=a1b2c3d4', { method: 'DELETE' });
	});
});

declare global {
	interface Window {
		YTB: {
			deleteMember(code: string, clientId: string): Promise<{ ok: true } | false>;
		};
	}
}
