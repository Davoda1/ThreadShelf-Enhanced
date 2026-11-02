/* global requestAnimationFrame, cancelAnimationFrame, atob, window, performance */
/* Shared queued Web Audio playback. Decoded buffers are retained for free replay. */
(function (root) {
  'use strict';
  const EPSILON = 0.0001;
  const MAX_SAMPLES = 128 * 1024 * 1024;
  const FILTER_RADIUS = 16,
    FILTER_PHASES = 1024,
    RENDER_AHEAD = 1.5,
    FADE_SECONDS = 0.004;
  // decodeAudioData resamples each WAV in isolation. A transport packet is not
  // a recording boundary: retain its original samples and interpolate across
  // packets on one output-frame clock instead.
  function pcmWave(context, bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let format = null,
      data = null;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (start + size > bytes.length) return null;
      if (tag(offset) === 'fmt ' && size >= 16)
        format = {
          kind: view.getUint16(start, true),
          channels: view.getUint16(start + 2, true),
          rate: view.getUint32(start + 4, true),
          stride: view.getUint16(start + 12, true),
          bits: view.getUint16(start + 14, true),
        };
      if (tag(offset) === 'data') data = { start, size };
      offset = start + size + (size & 1);
    }
    if (
      !format ||
      !data ||
      ![1, 2].includes(format.channels) ||
      format.rate < 8000 ||
      format.rate > 192000 ||
      !((format.kind === 1 && format.bits === 16) || (format.kind === 3 && format.bits === 32))
    )
      return null;
    const width = format.bits / 8,
      frames = data.size / (width * format.channels);
    if (!Number.isInteger(frames) || !frames || format.stride !== width * format.channels)
      return null;
    const buffer = context.createBuffer(format.channels, frames, format.rate);
    for (let channel = 0; channel < format.channels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        const offset = data.start + (frame * format.channels + channel) * width;
        samples[frame] =
          format.kind === 1 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
        if (!Number.isFinite(samples[frame]))
          throw new Error('The provider returned invalid PCM speech audio.');
      }
    }
    return buffer;
  }
  class ThreadShelfTtsPlayer {
    constructor({
      onState = () => {},
      onLevel = () => {},
      onError = () => {},
      volume = 1,
      rate = 1,
      meter = false,
    } = {}) {
      this.onState = onState;
      this.onLevel = onLevel;
      this.onError = onError;
      this.meter = !!meter;
      this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
      this.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
      this.buffers = [];
      this.duration = 0;
      this.position = 0;
      this.complete = false;
      this.wanted = false;
      this.ended = false;
      this.disposed = false;
      this.failed = false;
      this.sources = new Set();
      this.generation = 0;
      this.anchorTime = null;
      this.anchorPosition = 0;
      this.scheduledMediaEnd = 0;
      this.scheduledContextEnd = 0;
      this.renderedFrames = 0;
      this.kernels = new Map();
      this.transportGain = null;
      this.decodeQueue = Promise.resolve();
      this.samples = 0;
      this.raf = 0;
      this.lastStateTick = 0;
      this.context = null;
      this.gain = null;
      this.analyser = null;
      this.sampleData = null;
    }
    _context() {
      if (this.disposed) throw new Error('The speech player is closed.');
      if (this.context) return this.context;
      const Context = root.AudioContext || root.webkitAudioContext;
      if (!Context) throw new Error('Audio playback is unavailable in this browser.');
      this.context = new Context({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.transportGain = this.context.createGain();
      this.transportGain.connect(this.gain);
      if (this.meter) {
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0;
        this.sampleData = new Float32Array(this.analyser.fftSize);
        this.gain.connect(this.analyser);
        this.analyser.connect(this.context.destination);
      } else this.gain.connect(this.context.destination);
      return this.context;
    }
    _current() {
      if (this.wanted && this.anchorTime !== null && this.context) {
        return Math.max(
          0,
          Math.min(
            this.scheduledMediaEnd,
            this.anchorPosition +
              Math.max(0, this.context.currentTime - this.anchorTime) * this.rate,
          ),
        );
      }
      return Math.max(0, Math.min(this.duration, this.position));
    }
    snapshot() {
      const hasAudio = this.buffers.length > 0,
        buffering = this.wanted && (!hasAudio || this.sources.size === 0) && !this.ended;
      return {
        playing: this.wanted && !buffering && !this.ended,
        paused: !this.wanted && !this.ended,
        ended: this.ended,
        buffering,
        currentTime: this._current(),
        duration: this.duration,
        complete: this.complete,
        hasAudio,
        rate: this.rate,
        volume: this.volume,
      };
    }
    _emit() {
      if (!this.disposed) this.onState(this.snapshot());
    }
    _zeroLevel() {
      if (this.meter) this.onLevel({ rms: 0, db: -120, peak: 0 });
    }
    _tick() {
      this.raf = 0;
      if (this.disposed) return;
      const now = performance.now();
      if (now - this.lastStateTick >= 50) {
        this.lastStateTick = now;
        this._schedule();
      }
      if (this.meter && this.analyser && this.wanted && this.sources.size) {
        this.analyser.getFloatTimeDomainData(this.sampleData);
        let square = 0,
          peak = 0;
        for (const value of this.sampleData) {
          square += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
        const rms = Math.sqrt(square / this.sampleData.length);
        this.onLevel({ rms, db: 20 * Math.log10(Math.max(1e-6, rms)), peak });
      } else this._zeroLevel();
      if (this.wanted || this.sources.size) this.raf = requestAnimationFrame(() => this._tick());
    }
    _ensureTick() {
      if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(() => this._tick());
    }
    _cancelSources() {
      ++this.generation;
      const oldGain = this.transportGain,
        oldSources = [...this.sources],
        end = (this.context?.currentTime || 0) + FADE_SECONDS;
      let remaining = oldSources.length;
      if (oldGain && remaining) {
        oldGain.gain.cancelAndHoldAtTime(this.context.currentTime);
        oldGain.gain.linearRampToValueAtTime(0, end);
        this.transportGain = null;
      }
      for (const source of oldSources) {
        source.onended = () => {
          try {
            source.disconnect();
          } catch {
            /* Audio nodes may already be disconnected. */
          }
          if (!--remaining && oldGain)
            try {
              oldGain.disconnect();
            } catch {
              /* Audio nodes may already be disconnected. */
            }
        };
        try {
          source.stop(end);
        } catch {
          source.onended();
        }
      }
      this.sources.clear();
      this.anchorTime = null;
      this.scheduledContextEnd = 0;
      this.scheduledMediaEnd = this.position;
      this.renderedFrames = 0;
    }
    _settle() {
      if (this.disposed || !this.wanted || this.sources.size) return;
      this.position = Math.min(this.duration, this.scheduledMediaEnd);
      this.anchorTime = null;
      if (this.complete && this.position >= this.duration - EPSILON) {
        this.position = this.duration;
        this.wanted = false;
        this.ended = this.buffers.length > 0;
        this._zeroLevel();
      }
      this._emit();
      this._ensureTick();
    }
    _kernel(sampleRate) {
      const ratio = (this.rate * sampleRate) / this.context.sampleRate,
        key = String(ratio);
      if (this.kernels.has(key)) return this.kernels.get(key);
      const cutoff = Math.min(1, 1 / ratio),
        width = FILTER_RADIUS * 2,
        table = new Float32Array((FILTER_PHASES + 1) * width);
      for (let phase = 0; phase <= FILTER_PHASES; phase++) {
        let sum = 0;
        const fraction = phase / FILTER_PHASES;
        for (let tap = 0; tap < width; tap++) {
          const x = tap - (FILTER_RADIUS - 1) - fraction,
            scaled = x * cutoff;
          const sinc =
              Math.abs(scaled) < 1e-10 ? 1 : Math.sin(Math.PI * scaled) / (Math.PI * scaled),
            window =
              0.42 +
              0.5 * Math.cos((Math.PI * x) / FILTER_RADIUS) +
              0.08 * Math.cos((2 * Math.PI * x) / FILTER_RADIUS),
            value = Math.abs(x) >= FILTER_RADIUS ? 0 : cutoff * sinc * window;
          table[phase * width + tap] = value;
          sum += value;
        }
        for (let tap = 0; tap < width; tap++) table[phase * width + tap] /= sum;
      }
      this.kernels.set(key, table);
      return table;
    }
    _render(frames) {
      const context = this.context,
        channels = Math.max(...this.buffers.map((entry) => entry.buffer.numberOfChannels)),
        output = context.createBuffer(channels, frames, context.sampleRate),
        step = this.rate / context.sampleRate,
        width = FILTER_RADIUS * 2;
      const outputData = Array.from({ length: channels }, (_, channel) =>
        output.getChannelData(channel),
      );
      let index = 0,
        kernelEntry = null,
        kernel = null;
      while (
        index + 1 < this.buffers.length &&
        this.buffers[index].end <= this.anchorPosition + this.renderedFrames * step
      )
        index++;
      for (let frame = 0; frame < frames; frame++) {
        const time = this.anchorPosition + (this.renderedFrames + frame) * step;
        while (index + 1 < this.buffers.length && this.buffers[index].end <= time) index++;
        const entry = this.buffers[index],
          rate = entry.buffer.sampleRate,
          at = (time - entry.start) * rate,
          base = Math.floor(at),
          phase = Math.round((at - base) * FILTER_PHASES),
          kernelOffset = phase * width;
        if (entry !== kernelEntry) {
          kernelEntry = entry;
          kernel = this._kernel(rate);
        }
        for (let channel = 0; channel < channels; channel++) {
          let sum = 0;
          const data = entry.data[Math.min(channel, entry.data.length - 1)];
          for (let tap = 0; tap < width; tap++) {
            let sample = base + tap - (FILTER_RADIUS - 1),
              value = 0;
            if (sample >= 0 && sample < data.length) value = data[sample];
            else {
              let neighbour = index;
              const sampleTime = entry.start + sample / rate;
              while (neighbour > 0 && sampleTime < this.buffers[neighbour].start - 1e-10)
                neighbour--;
              while (
                neighbour + 1 < this.buffers.length &&
                sampleTime >= this.buffers[neighbour].end - 1e-10
              )
                neighbour++;
              const other = this.buffers[neighbour],
                otherFrame = Math.round((sampleTime - other.start) * other.buffer.sampleRate),
                otherData = other.data[Math.min(channel, other.data.length - 1)];
              if (otherFrame >= 0 && otherFrame < otherData.length) value = otherData[otherFrame];
            }
            sum += value * kernel[kernelOffset + tap];
          }
          outputData[channel][frame] = sum;
        }
      }
      return output;
    }
    _smoothBoundary() {
      if (!this.transportGain || !this.sources.size) return;
      const now = this.context.currentTime,
        gain = this.transportGain.gain,
        start = this.anchorTime,
        end = this.scheduledContextEnd;
      // This tail fade is cancelled whenever more audio arrives in time. Only
      // real silence (start, finish or an underrun) receives a fade, not packets.
      if (now < start) {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(0, now);
        gain.setValueAtTime(0, start);
        gain.linearRampToValueAtTime(1, Math.min(end, start + FADE_SECONDS));
      } else {
        gain.cancelAndHoldAtTime(now);
        gain.linearRampToValueAtTime(1, Math.min(end, now + FADE_SECONDS));
      }
      const tail = Math.max(now + FADE_SECONDS, start + FADE_SECONDS, end - FADE_SECONDS);
      if (tail < end) {
        gain.setValueAtTime(1, tail);
        gain.linearRampToValueAtTime(0, end);
      }
    }
    _schedule() {
      if (this.disposed || this.failed || !this.wanted) return;
      const context = this._context(),
        last = this.buffers.at(-1);
      if (!this.transportGain) {
        this.transportGain = context.createGain();
        this.transportGain.connect(this.gain);
      }
      if (!last) {
        this._emit();
        this._ensureTick();
        return;
      }
      const limit = this.complete
        ? this.duration
        : Math.max(0, this.duration - FILTER_RADIUS / last.buffer.sampleRate);
      if (!this.sources.size && !this.complete && limit - this.scheduledMediaEnd < 0.12) {
        this._settle();
        return;
      }
      if (this.anchorTime === null) {
        this.anchorPosition = this.position;
        this.anchorTime =
          Math.ceil((context.currentTime + 0.025) * context.sampleRate) / context.sampleRate;
        this.renderedFrames = 0;
        this.scheduledContextEnd = this.anchorTime;
        this.scheduledMediaEnd = this.position;
      }
      // Refill after a genuine underrun without skipping source samples.
      if (!this.sources.size && this.scheduledContextEnd < context.currentTime + 0.005) {
        this.position = this.scheduledMediaEnd;
        this.anchorPosition = this.position;
        this.anchorTime =
          Math.ceil((context.currentTime + 0.025) * context.sampleRate) / context.sampleRate;
        this.renderedFrames = 0;
        this.scheduledContextEnd = this.anchorTime;
      }
      const available = ((limit - this.anchorPosition) * context.sampleRate) / this.rate,
        totalFrames = Math.max(
          0,
          this.complete ? Math.ceil(available - 1e-7) : Math.floor(available + 1e-7),
        );
      let added = false;
      while (
        this.renderedFrames < totalFrames &&
        this.scheduledContextEnd < context.currentTime + RENDER_AHEAD
      ) {
        const frames = Math.min(
            totalFrames - this.renderedFrames,
            Math.ceil(context.sampleRate * 0.5),
          ),
          buffer = this._render(frames),
          source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.transportGain || this.gain);
        const token = this.generation;
        source.onended = () => {
          this.sources.delete(source);
          try {
            source.disconnect();
          } catch {
            /* Audio nodes may already be disconnected. */
          }
          if (this.disposed || token !== this.generation) return;
          this._schedule();
          if (!this.sources.size) this._settle();
        };
        this.sources.add(source);
        source.start(this.scheduledContextEnd);
        this.renderedFrames += frames;
        this.scheduledContextEnd = this.anchorTime + this.renderedFrames / context.sampleRate;
        this.scheduledMediaEnd = Math.min(
          this.duration,
          this.anchorPosition + (this.renderedFrames * this.rate) / context.sampleRate,
        );
        added = true;
      }
      if (added) this._smoothBoundary();
      if (!this.sources.size) this._settle();
      this._emit();
      this._ensureTick();
    }
    append({ audioBase64, mime } = {}) {
      const task = this.decodeQueue
        .then(async () => {
          if (this.disposed || this.failed) return this.snapshot();
          if (
            typeof audioBase64 !== 'string' ||
            audioBase64.length > 96 * 1024 * 1024 ||
            ![
              'audio/wav',
              'audio/x-wav',
              'audio/mpeg',
              'audio/mp3',
              'audio/mp4',
              'audio/ogg',
              'audio/webm',
            ].includes(mime)
          )
            throw new Error('The provider returned unsupported speech audio.');
          const binary = atob(audioBase64),
            bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const context = this._context(),
            buffer = pcmWave(context, bytes) || (await context.decodeAudioData(bytes.buffer));
          if (this.disposed) return this.snapshot();
          if (!buffer.length || !Number.isFinite(buffer.duration) || buffer.duration <= 0)
            throw new Error('The provider returned empty speech audio.');
          const samples = buffer.length * buffer.numberOfChannels;
          if (this.samples + samples > MAX_SAMPLES)
            throw new Error('This speech exceeds the local playback memory limit.');
          const start = this.duration;
          this.samples += samples;
          this.duration += buffer.duration;
          this.buffers.push({
            buffer,
            data: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
              buffer.getChannelData(channel),
            ),
            start,
            end: this.duration,
          });
          this.ended = false;
          this._schedule();
          this._emit();
          return this.snapshot();
        })
        .catch((error) => {
          if (!this.disposed) {
            this.failed = true;
            this.wanted = false;
            this.position = this._current();
            this._cancelSources();
            this._zeroLevel();
            this.onError(error);
            this._emit();
          }
          throw error;
        });
      this.decodeQueue = task.catch(() => {});
      return task;
    }
    async finish() {
      await this.decodeQueue;
      if (this.disposed || this.failed) return this.snapshot();
      this.complete = true;
      this._schedule();
      this._settle();
      this._emit();
      return this.snapshot();
    }
    async play() {
      if (this.disposed || this.failed) return this.snapshot();
      const context = this._context();
      this.wanted = true;
      if (
        this.ended ||
        (this.complete && this.buffers.length && this.position >= this.duration - EPSILON)
      ) {
        this.position = 0;
        this.ended = false;
        this._cancelSources();
      }
      // Resume is requested directly from the button's trusted activation, before
      // any provider/network wait. Subsequent chunks use this same audio graph.
      const resumed = context.state === 'suspended' ? context.resume() : Promise.resolve();
      this._schedule();
      await resumed;
      if (!this.disposed && this.wanted) this._schedule();
      return this.snapshot();
    }
    pause() {
      if (this.disposed) return;
      this.position = this._current();
      this.wanted = false;
      this._cancelSources();
      this._zeroLevel();
      this._emit();
    }
    stop() {
      if (this.disposed) return;
      this.wanted = false;
      this.position = 0;
      this.ended = false;
      this._cancelSources();
      this._zeroLevel();
      this._emit();
    }
    async replay() {
      this.stop();
      return this.play();
    }
    seek(seconds) {
      if (this.disposed) return;
      this.position = Math.max(0, Math.min(this.duration, Number(seconds) || 0));
      this.ended = false;
      this._cancelSources();
      if (this.wanted) this._schedule();
      this._emit();
    }
    setRate(value) {
      const rate = Math.max(0.5, Math.min(2, Number(value) || 1));
      if (rate === this.rate) return;
      this.position = this._current();
      this.rate = rate;
      this.kernels.clear();
      this._cancelSources();
      if (this.wanted) this._schedule();
      this._emit();
    }
    setVolume(value) {
      this.volume = Math.max(0, Math.min(1, Number(value) || 0));
      if (this.gain) {
        this.gain.gain.cancelScheduledValues(this.context.currentTime);
        this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.005);
      }
      this._emit();
    }
    dispose() {
      if (this.disposed) return;
      this.wanted = false;
      this._cancelSources();
      this.disposed = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this._zeroLevel();
      this.buffers = [];
      this.kernels.clear();
      this.samples = 0;
      this.duration = 0;
      this.position = 0;
      this.context?.close().catch(() => {});
    }
  }
  root.ThreadShelfTtsPlayer = ThreadShelfTtsPlayer;
})(typeof window === 'object' ? window : globalThis);
