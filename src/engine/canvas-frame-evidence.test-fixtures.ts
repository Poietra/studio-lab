import type { GpuBufferV1 } from "./canvas-frame-evidence";

export type FakeGpuBuffer = GpuBufferV1 & { readonly content: Uint8Array; destroyCalls: number };

export type FakeGpuStageFailures = {
  copyTextureToBuffer?: Error;
  createBuffer?: Error;
  createCommandEncoder?: Error;
  finish?: Error;
  submit?: Error;
};

/**
 * A stageable fake device shared by the evidence-capture and canvas-worker
 * tests: buffers track destroy counts, and the queue resolves texture copies
 * at submit time by writing the source texture's fill byte into the
 * destination buffer. `failures` injects a throw at any staging stage.
 */
export function createFakeGpuDevice(failures: FakeGpuStageFailures = {}) {
  const buffers: FakeGpuBuffer[] = [];
  const originalSubmits: unknown[][] = [];
  let destroyCalls = 0;
  let resolveLost!: (loss: Readonly<{ message: string; reason: string }>) => void;
  const lost = new Promise<Readonly<{ message: string; reason: string }>>((resolve) => {
    resolveLost = resolve;
  });
  let copies: Readonly<{ buffer: FakeGpuBuffer; texture: { fill: number } }>[] = [];
  const device = {
    createBuffer: (descriptor: Readonly<{ size: number; usage: number }>) => {
      if (failures.createBuffer) throw failures.createBuffer;
      const content = new Uint8Array(descriptor.size);
      const buffer: FakeGpuBuffer = {
        content,
        destroy: () => {
          buffer.destroyCalls += 1;
        },
        destroyCalls: 0,
        getMappedRange: () => content.buffer,
        mapAsync: () => {
          if (buffer.destroyCalls > 0) return Promise.reject(new Error("Buffer was destroyed."));
          return Promise.resolve();
        },
        unmap: () => undefined,
      };
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => {
      if (failures.createCommandEncoder) throw failures.createCommandEncoder;
      let pendingCopy: Readonly<{ buffer: FakeGpuBuffer; texture: { fill: number } }> | null = null;
      return {
        copyTextureToBuffer: (source: unknown, destination: unknown) => {
          if (failures.copyTextureToBuffer) throw failures.copyTextureToBuffer;
          pendingCopy = {
            buffer: (destination as { buffer: FakeGpuBuffer }).buffer,
            texture: (source as { texture: { fill: number } }).texture,
          };
        },
        finish: () => {
          if (failures.finish) throw failures.finish;
          return { execute: () => pendingCopy && copies.push(pendingCopy) };
        },
      };
    },
    destroy: () => {
      destroyCalls += 1;
      resolveLost({ message: "The fake device was destroyed.", reason: "destroyed" });
    },
    lost,
    queue: {
      submit: (commands: Iterable<unknown>) => {
        if (failures.submit) throw failures.submit;
        const received = [...commands];
        originalSubmits.push(received);
        for (const command of received) {
          (command as { execute?: () => void }).execute?.();
        }
        for (const copy of copies) {
          copy.buffer.content.fill(copy.texture.fill);
        }
        copies = [];
      },
    },
  };
  return {
    buffers,
    device,
    get destroyCalls() {
      return destroyCalls;
    },
    originalSubmits,
  };
}
