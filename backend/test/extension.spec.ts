import { beforeAll, describe, expect, it, vi } from 'vitest';

let storage: Record<string, unknown>;

describe('extension member API', () => {
	beforeAll(async () => {
		storage = {};
		Object.assign(globalThis, {
			window: globalThis,
			chrome: {
				storage: {
					local: {
						get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
						set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values)),
					},
				},
			},
		});
		await import('../../extension/shared.js');
	});

	it('allocates unique colors, persists them by Room, and isolates Rooms', async () => {
		storage = {};
		const values = [0, 0, 0, 0];
		const roomA = await window.YTB.syncBuddyColors('room-a', ['a', 'b', 'c', 'd'], true, () => values.shift()!);
		expect(new Set(Object.values(roomA))).toHaveLength(4);
		expect(storage.buddyColors).toMatchObject({ 'room-a': roomA });

		const roomB = await window.YTB.syncBuddyColors('room-b', ['a'], true, () => 0.99);
		expect(roomB.a).not.toBe(roomA.a);
		expect(storage.buddyColors).toMatchObject({ 'room-a': roomA, 'room-b': roomB });
	});

	it('preserves assignments on failure, cleans up on success, and allocates a fresh rejoin color', async () => {
		storage = {};
		const initial = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0);
		await window.YTB.syncBuddyColors('room', [], false);
		expect((storage.buddyColors as any).room).toEqual(initial);

		await window.YTB.syncBuddyColors('room', ['b'], true);
		expect((storage.buddyColors as any).room.a).toBeUndefined();
		const rejoined = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0.99);
		expect(rejoined.a).not.toBe(initial.a);
	});

	it('rejects assigning a color used by another current Buddy', async () => {
		storage = {};
		const room = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0);
		await expect(window.YTB.setBuddyColor('room', 'b', room.a)).resolves.toBe(false);
	});

	it('clears only the Room the viewer leaves', async () => {
		storage = { buddyColors: { left: { a: '#00a6d6' }, kept: { b: '#f0a500' } } };
		await window.YTB.clearRoomColors('left');
		expect(storage.buddyColors).toEqual({ kept: { b: '#f0a500' } });
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
			syncBuddyColors(code: string, ids: string[], successful: boolean, random?: () => number): Promise<Record<string, string>>;
			setBuddyColor(code: string, clientId: string, color: string): Promise<boolean>;
			clearRoomColors(code: string): Promise<void>;
		};
	}
}
