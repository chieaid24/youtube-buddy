import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Feedback = {
	textContent: string;
	classList: {
		toggle(name: string, force: boolean): void;
		remove(name: string): void;
	};
};

type Button = {
	classList: {
		toggle(name: string, force: boolean): void;
		remove(name: string): void;
	};
};

describe('Room Code helpers', () => {
	beforeAll(async () => {
		Object.assign(globalThis, { window: globalThis });
		await import('../../extension/room-code.js');
	});

	beforeEach(() => vi.useRealTimers());

	it('generates normalized descriptor and plural-animal properties uniformly', () => {
		const { DESCRIPTORS, ANIMALS, generate } = window.YTBRoomCode;
		const seenDescriptors = new Set<string>();
		const seenAnimals = new Set<string>();

		for (let descriptorIndex = 0; descriptorIndex < DESCRIPTORS.length; descriptorIndex++) {
			for (let animalIndex = 0; animalIndex < ANIMALS.length; animalIndex++) {
				const values = [(descriptorIndex + 0.5) / DESCRIPTORS.length, (animalIndex + 0.5) / ANIMALS.length];
				const slug = generate(() => values.shift()!);
				const [descriptor, animal] = slug.split('-');
				expect(DESCRIPTORS).toContain(descriptor);
				expect(ANIMALS).toContain(animal);
				expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
				seenDescriptors.add(descriptor);
				seenAnimals.add(animal);
			}
		}

		expect(seenDescriptors.size).toBe(DESCRIPTORS.length);
		expect(seenAnimals.size).toBe(ANIMALS.length);
	});

	it('mixes cute, color, and action descriptors without rejected vocabulary', () => {
		const descriptors = window.YTBRoomCode.DESCRIPTORS;
		expect(descriptors).toEqual(expect.arrayContaining(['snuggly', 'purple', 'dancing']));
		expect(descriptors).not.toEqual(expect.arrayContaining(['grumpy', 'derpy', 'dorky', 'pudgy']));
	});

	it('formats any normalized slug as a pretty Room Code', () => {
		expect(window.YTBRoomCode.pretty('dancing-otters')).toBe('The Dancing Otters');
		expect(window.YTBRoomCode.pretty('custom-code-outside-vocabulary')).toBe('The Custom Code Outside Vocabulary');
	});

	it.each([
		['success', vi.fn().mockResolvedValue(undefined), 'Copied!', false, true],
		['failure', vi.fn().mockRejectedValue(new Error('denied')), 'Could not copy', true, false],
	])('shows and clears anchored copy %s feedback', async (_case, writeText, message, isError, expected) => {
		vi.useFakeTimers();
		const classes = new Set<string>();
		const feedback: Feedback = {
			textContent: '',
			classList: {
				toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
				remove: (name) => void classes.delete(name),
			},
		};

		await expect(window.YTBRoomCode.copy({ text: 'The Dancing Otters', feedback, writeText })).resolves.toBe(expected);
		expect(writeText).toHaveBeenCalledWith('The Dancing Otters');
		expect(feedback.textContent).toBe(message);
		expect(classes.has('is-error')).toBe(isError);

		await vi.advanceTimersByTimeAsync(1500);
		expect(feedback.textContent).toBe('');
	});

	it('crossfades the copy button into a checkmark on success, reverting after the feedback duration', async () => {
		vi.useFakeTimers();
		const feedback: Feedback = {
			textContent: '',
			classList: { toggle: vi.fn(), remove: vi.fn() },
		};
		const buttonClasses = new Set<string>();
		const button: Button = {
			classList: {
				toggle: (name, force) => (force ? buttonClasses.add(name) : buttonClasses.delete(name)),
				remove: (name) => void buttonClasses.delete(name),
			},
		};
		const writeText = vi.fn().mockResolvedValue(undefined);

		await window.YTBRoomCode.copy({ text: 'The Dancing Otters', feedback, button, writeText });
		expect(buttonClasses.has('is-copied')).toBe(true);

		await vi.advanceTimersByTimeAsync(1500);
		expect(buttonClasses.has('is-copied')).toBe(false);
	});

	it('leaves the copy button unchanged on a failed copy', async () => {
		vi.useFakeTimers();
		const feedback: Feedback = {
			textContent: '',
			classList: { toggle: vi.fn(), remove: vi.fn() },
		};
		const buttonClasses = new Set<string>();
		const button: Button = {
			classList: {
				toggle: (name, force) => (force ? buttonClasses.add(name) : buttonClasses.delete(name)),
				remove: (name) => void buttonClasses.delete(name),
			},
		};
		const writeText = vi.fn().mockRejectedValue(new Error('denied'));

		await window.YTBRoomCode.copy({ text: 'The Dancing Otters', feedback, button, writeText });
		expect(buttonClasses.has('is-copied')).toBe(false);
	});
});

declare global {
	interface Window {
		YTBRoomCode: {
			DESCRIPTORS: readonly string[];
			ANIMALS: readonly string[];
			generate(random?: () => number): string;
			pretty(slug: string): string;
			copy(options: {
				text: string;
				feedback: Feedback;
				button?: Button;
				writeText?: (text: string) => Promise<void>;
				durationMs?: number;
			}): Promise<boolean>;
		};
	}
}
