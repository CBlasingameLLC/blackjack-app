// ==========================================
// audio.js — BJ.AudioEngine (Phase C)
//
// Ported near-verbatim from the old monolith's `AudioEngine` object
// (blackjack.js:16-63) — WebAudio-based SFX loader/player, chosen
// specifically because it bypasses the iOS "Media Player" chrome that
// <audio> tags trigger. Behavior is unchanged; only the namespacing
// convention (BJ.AudioEngine + dual browser/Node export guard, matching
// every other file in this directory) is new.
//
// This file has no dependencies on any other BJ.* module and is never
// require()'d from the Node verification scripts (it needs a real
// AudioContext/fetch), but it still gets the same module.exports guard for
// consistency and in case a future headless-DOM test wants to stub it.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    const AudioEngine = {
        enabled: false,
        context: null,
        buffers: {},
        sounds: {
            card: '/assets/sounds/card.wav',
            chip: '/assets/sounds/chip.wav',
            shuffle: '/assets/sounds/shuffle.wav',
            win: '/assets/sounds/win.wav',
            loss: '/assets/sounds/loss.wav'
        },

        /**
         * Creates the (suspended-until-gesture) AudioContext and kicks off
         * fetch+decode for every sound in `this.sounds`. Safe to call more
         * than once — a no-op after the first successful init.
         */
        init() {
            if (this.context) return; // Already initialized
            if (typeof window === 'undefined') return; // guard: no AudioContext outside a browser

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) return;
            this.context = new AudioContextCtor();

            for (let key in this.sounds) {
                if (!Object.prototype.hasOwnProperty.call(this.sounds, key)) continue;
                fetch(this.sounds[key])
                    .then((response) => response.arrayBuffer())
                    .then((arrayBuffer) => this.context.decodeAudioData(arrayBuffer))
                    .then((audioBuffer) => { this.buffers[key] = audioBuffer; })
                    .catch((err) => {
                        if (typeof console !== 'undefined') console.log(`Audio load error for ${key}:`, err);
                    });
            }
        },

        /**
         * Fires a one-shot playback of `soundName`. No-ops silently if
         * sound is disabled, the buffer hasn't finished loading yet, or
         * there's no context (e.g. `init()` was never called or failed).
         * Spawns a fresh BufferSource per call so overlapping calls (e.g.
         * rapid-fire card sounds) play polyphonically instead of cutting
         * each other off.
         */
        play(soundName) {
            if (!this.enabled || !this.buffers[soundName] || !this.context) return;

            // Wake the context if iOS Safari auto-suspended it.
            if (this.context.state === 'suspended') this.context.resume();

            const source = this.context.createBufferSource();
            source.buffer = this.buffers[soundName];

            const gainNode = this.context.createGain();
            gainNode.gain.value = 0.4; // fixed volume, matches the old engine

            source.connect(gainNode);
            gainNode.connect(this.context.destination);
            source.start(0);
        }
    };

    BJ.AudioEngine = AudioEngine;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = AudioEngine;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
