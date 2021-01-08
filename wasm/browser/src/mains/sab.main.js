import * as Comlink from "comlink";
import { api as API } from "@root/libcsound";
import { messageEventHandler, IPCMessagePorts } from "@root/mains/messages.main";
import { makeSABPerfCallback } from "@root/sab.main.utils";
import SABWorker from "@root/workers/sab.worker";
import {
  AUDIO_STATE,
  CALLBACK_DATA_BUFFER_SIZE,
  DATA_TYPE,
  MAX_CHANNELS,
  MAX_HARDWARE_BUFFER_SIZE,
  MIDI_BUFFER_PAYLOAD_SIZE,
  MIDI_BUFFER_SIZE,
  initialSharedState,
} from "@root/constants";
import { logSAB } from "@root/logger";
import { isEmpty } from "ramda";
import { csoundApiRename, fetchPlugins, makeProxyCallback, stopableStates } from "@root/utils";
import * as events from "@root/events";

class SharedArrayBufferMainThread {
  constructor({ audioWorker, wasmDataURI, audioContextIsProvided }) {
    this.hasSharedArrayBuffer = true;
    this.ipcMessagePorts = new IPCMessagePorts();
    audioWorker.ipcMessagePorts = this.ipcMessagePorts;

    this.audioWorker = audioWorker;
    this.audioContextIsProvided = audioContextIsProvided;
    this.csoundInstance = undefined;
    this.wasmDataURI = wasmDataURI;
    this.currentPlayState = undefined;
    this.currentDerivedPlayState = "stop";
    this.exportApi = {};
    this.messageCallbacks = [];
    this.csoundPlayStateChangeCallbacks = [];

    this.startPromiz = undefined;
    this.stopPromiz = undefined;

    this.audioStateBuffer = new SharedArrayBuffer(
      initialSharedState.length * Int32Array.BYTES_PER_ELEMENT,
    );

    this.audioStatePointer = new Int32Array(this.audioStateBuffer);

    this.audioStreamIn = new SharedArrayBuffer(
      MAX_CHANNELS * MAX_HARDWARE_BUFFER_SIZE * Float64Array.BYTES_PER_ELEMENT,
    );
    this.audioStreamOut = new SharedArrayBuffer(
      MAX_CHANNELS * MAX_HARDWARE_BUFFER_SIZE * Float64Array.BYTES_PER_ELEMENT,
    );

    this.midiBufferSAB = new SharedArrayBuffer(
      MIDI_BUFFER_SIZE * MIDI_BUFFER_PAYLOAD_SIZE * Int32Array.BYTES_PER_ELEMENT,
    );

    this.midiBuffer = new Int32Array(this.midiBufferSAB);

    this.callbackBufferSAB = new SharedArrayBuffer(1024 * Int32Array.BYTES_PER_ELEMENT);

    this.callbackBuffer = new Int32Array(this.callbackBufferSAB);

    this.callbackStringDataBufferSAB = new SharedArrayBuffer(
      CALLBACK_DATA_BUFFER_SIZE * Int8Array.BYTES_PER_ELEMENT,
    );

    this.callbackStringDataBuffer = new Uint8Array(this.callbackStringDataBufferSAB);

    this.callbackFloatArrayDataBufferSAB = new SharedArrayBuffer(
      CALLBACK_DATA_BUFFER_SIZE * Float64Array.BYTES_PER_ELEMENT,
    );

    this.callbackFloatArrayDataBuffer = new Float64Array(this.callbackFloatArrayDataBufferSAB);

    this.onPlayStateChange = this.onPlayStateChange.bind(this);
    logSAB(`SharedArrayBufferMainThread got constructed`);
  }

  get api() {
    return this.exportApi;
  }

  handleMidiInput({ data: [status, data1, data2] }) {
    const currentQueueLength = Atomics.load(
      this.audioStatePointer,
      AUDIO_STATE.AVAIL_RTMIDI_EVENTS,
    );
    const rtmidiBufferIndex = Atomics.load(this.audioStatePointer, AUDIO_STATE.RTMIDI_INDEX);
    const nextIndex =
      (currentQueueLength * MIDI_BUFFER_PAYLOAD_SIZE + rtmidiBufferIndex) % MIDI_BUFFER_SIZE;

    Atomics.store(this.midiBuffer, nextIndex, status);
    Atomics.store(this.midiBuffer, nextIndex + 1, data1);
    Atomics.store(this.midiBuffer, nextIndex + 2, data2);
    Atomics.add(this.audioStatePointer, AUDIO_STATE.AVAIL_RTMIDI_EVENTS, 1);
  }

  async addMessageCallback(callback) {
    if (typeof callback === "function") {
      this.messageCallbacks.push(callback);
    } else {
      console.error(`Can't assign ${typeof callback} as a message callback`);
    }
  }

  async setMessageCallback(callback) {
    if (typeof callback === "function") {
      this.messageCallbacks = [callback];
    } else {
      console.error(`Can't assign ${typeof callback} as a message callback`);
    }
  }

  // User-land hook to csound's play-state changes
  async setCsoundPlayStateChangeCallback(callback) {
    if (typeof callback !== "function") {
      console.error(`Can't assign ${typeof callback} as a playstate change callback`);
    } else {
      this.csoundPlayStateChangeCallbacks = [callback];
    }
  }

  async addCsoundPlayStateChangeCallback(callback) {
    if (typeof callback !== "function") {
      console.error(`Can't assign ${typeof callback} as a playstate change callback`);
    } else {
      this.csoundPlayStateChangeCallbacks.push(callback);
    }
  }

  async csoundPause() {
    if (
      Atomics.load(this.audioStatePointer, AUDIO_STATE.IS_PAUSED) !== 1 &&
      Atomics.load(this.audioStatePointer, AUDIO_STATE.STOP) !== 1 &&
      Atomics.load(this.audioStatePointer, AUDIO_STATE.IS_PERFORMING) === 1
    ) {
      Atomics.store(this.audioStatePointer, AUDIO_STATE.IS_PAUSED, 1);
      this.onPlayStateChange("realtimePerformancePaused");
    }
  }

  async csoundResume() {
    if (
      Atomics.load(this.audioStatePointer, AUDIO_STATE.IS_PAUSED) === 1 &&
      Atomics.load(this.audioStatePointer, AUDIO_STATE.STOP) !== 1 &&
      Atomics.load(this.audioStatePointer, AUDIO_STATE.IS_PERFORMING) === 1
    ) {
      Atomics.store(this.audioStatePointer, AUDIO_STATE.IS_PAUSED, 0);
      Atomics.notify(this.audioStatePointer, AUDIO_STATE.IS_PAUSED);
      this.onPlayStateChange("realtimePerformanceResumed");
    }
  }

  async onPlayStateChange(newPlayState) {
    this.currentPlayState = newPlayState;

    switch (newPlayState) {
      case "realtimePerformanceStarted": {
        logSAB(
          `event: realtimePerformanceStarted received,` +
            ` proceeding to call prepareRealtimePerformance`,
        );
        await this.prepareRealtimePerformance();
        events.triggerRealtimePerformanceStarted(this);
        break;
      }
      case "realtimePerformanceEnded": {
        logSAB(`event: realtimePerformanceEnded received, beginning cleanup`);
        if (this.stopPromiz) {
          this.stopPromiz();
          delete this.stopPromiz;
        }
        events.triggerRealtimePerformanceEnded(this);
        // re-initialize SAB
        initialSharedState.forEach((value, index) => {
          Atomics.store(this.audioStatePointer, index, value);
        });
        break;
      }
      case "realtimePerformancePaused": {
        events.triggerRealtimePerformancePaused(this);
        break;
      }
      case "realtimePerformanceResumed": {
        events.triggerRealtimePerformanceResumed(this);
        break;
      }
      case "renderStarted": {
        events.triggerRenderStarted(this);
        break;
      }
      case "renderEnded": {
        if (this.stopPromiz) {
          this.stopPromiz();
          delete this.stopPromiz;
        }
        events.triggerRenderEnded(this);
        logSAB(`event: renderEnded received, beginning cleanup`);
        break;
      }
      default: {
        break;
      }
    }

    // forward the message from worker to the audioWorker
    try {
      await this.audioWorker.onPlayStateChange(newPlayState);
    } catch (error) {
      console.error(error);
    }

    if (this.startPromiz && newPlayState !== "realtimePerformanceStarted") {
      // either we are rendering or something went wrong with the start
      // otherwise the audioWorker resolves this
      this.startPromiz();
      delete this.startPromiz;
    }

    this.csoundPlayStateChangeCallbacks.forEach((callback) => {
      try {
        callback(newPlayState);
      } catch (error) {
        console.error(error);
      }
    });
  }

  async prepareRealtimePerformance() {
    logSAB(`prepareRealtimePerformance`);
    const outputsCount = Atomics.load(this.audioStatePointer, AUDIO_STATE.NCHNLS);
    const inputCount = Atomics.load(this.audioStatePointer, AUDIO_STATE.NCHNLS_I);

    this.audioWorker.isRequestingInput = inputCount > 0;
    this.audioWorker.isRequestingMidi = Atomics.load(
      this.audioStatePointer,
      AUDIO_STATE.IS_REQUESTING_RTMIDI,
    );

    const sampleRate = Atomics.load(this.audioStatePointer, AUDIO_STATE.SAMPLE_RATE);

    const hardwareBufferSize = Atomics.load(this.audioStatePointer, AUDIO_STATE.HW_BUFFER_SIZE);

    const softwareBufferSize = Atomics.load(this.audioStatePointer, AUDIO_STATE.SW_BUFFER_SIZE);

    this.audioWorker.sampleRate = sampleRate;
    this.audioWorker.inputCount = inputCount;
    this.audioWorker.outputsCount = outputsCount;
    this.audioWorker.hardwareBufferSize = hardwareBufferSize;
    this.audioWorker.softwareBufferSize = softwareBufferSize;
  }

  async initialize({ withPlugins }) {
    if (withPlugins && !isEmpty(withPlugins)) {
      withPlugins = await fetchPlugins(withPlugins);
    }

    logSAB(`initialization: instantiate the SABWorker Thread`);
    const csoundWorker = new Worker(SABWorker());
    this.csoundWorker = csoundWorker;
    const audioStateBuffer = this.audioStateBuffer;
    const audioStatePointer = this.audioStatePointer;
    const audioStreamIn = this.audioStreamIn;
    const audioStreamOut = this.audioStreamOut;
    const midiBuffer = this.midiBuffer;
    const callbackBuffer = this.callbackBuffer;
    const callbackStringDataBuffer = this.callbackStringDataBuffer;
    const callbackFloatArrayDataBuffer = this.callbackFloatArrayDataBuffer;

    // This will sadly create circular structure
    // that's still mostly harmless.
    logSAB(`providing the audioWorker a pointer to SABMain's instance`);
    this.audioWorker.csoundWorkerMain = this;

    // both audio worker and csound worker use 1 handler
    // simplifies flow of data (csound main.worker is always first to receive)
    logSAB(`adding message eventListeners for mainMessagePort and mainMessagePortAudio`);
    this.ipcMessagePorts.mainMessagePort.addEventListener("message", messageEventHandler(this));
    this.ipcMessagePorts.mainMessagePortAudio.addEventListener(
      "message",
      messageEventHandler(this),
    );
    logSAB(
      `(postMessage) making a message channel from SABMain to SABWorker via workerMessagePort`,
    );

    // we send callbacks to the worker in SAB, but receive these return values as message events
    let returnQueue = {};
    this.ipcMessagePorts.sabMainCallbackReply.addEventListener("message", (event) => {
      const { uid, value } = event.data;
      const promize = returnQueue[uid];
      promize && promize(value);
    });

    const proxyPort = Comlink.wrap(csoundWorker);
    const csoundInstance = await proxyPort.initialize(
      Comlink.transfer(
        {
          wasmDataURI: this.wasmDataURI,
          messagePort: this.ipcMessagePorts.workerMessagePort,
          callbackReplyPort: this.ipcMessagePorts.sabWorkerCallbackReply,
          withPlugins,
        },
        [this.ipcMessagePorts.workerMessagePort, this.ipcMessagePorts.sabWorkerCallbackReply],
      ),
    );
    this.csoundInstance = csoundInstance;

    this.ipcMessagePorts.mainMessagePort.start();
    this.ipcMessagePorts.mainMessagePortAudio.start();

    logSAB(`A proxy port from SABMain to SABWorker established`);

    this.exportApi.setMessageCallback = this.setMessageCallback.bind(this);
    this.exportApi.addMessageCallback = this.addMessageCallback.bind(this);
    this.exportApi.setCsoundPlayStateChangeCallback = this.setCsoundPlayStateChangeCallback.bind(
      this,
    );
    this.exportApi.addCsoundPlayStateChangeCallback = this.addCsoundPlayStateChangeCallback.bind(
      this,
    );

    this.exportApi.pause = this.csoundPause.bind(this);
    this.exportApi.resume = this.csoundResume.bind(this);

    this.exportApi.writeToFs = makeProxyCallback(proxyPort, csoundInstance, "writeToFs");
    this.exportApi.readFromFs = makeProxyCallback(proxyPort, csoundInstance, "readFromFs");
    this.exportApi.llFs = makeProxyCallback(proxyPort, csoundInstance, "llFs");
    this.exportApi.lsFs = makeProxyCallback(proxyPort, csoundInstance, "lsFs");
    this.exportApi.rmrfFs = makeProxyCallback(proxyPort, csoundInstance, "rmrfFs");

    this.exportApi.getNode = async () => {
      const maybeNode = this.audioWorker.audioWorkletNode;
      return maybeNode;
    };

    this.exportApi.getAudioContext = async () => this.audioWorker.audioContext;

    this.exportApi = events.decorateAPI(this.exportApi);

    for (const apiK of Object.keys(API)) {
      const proxyCallback = makeProxyCallback(proxyPort, csoundInstance, apiK);
      const reference = API[apiK];

      switch (apiK) {
        case "csoundCreate": {
          break;
        }
        case "csoundStart": {
          const csoundStart = async function () {
            if (!csoundInstance || typeof csoundInstance !== "number") {
              console.error("starting csound failed because csound instance wasn't created");
              return -1;
            }

            const startPromise = new Promise((resolve) => {
              this.startPromiz = resolve;
            });

            const startResult = await proxyCallback({
              audioStateBuffer,
              audioStreamIn,
              audioStreamOut,
              midiBuffer,
              callbackBuffer,
              callbackStringDataBuffer,
              callbackFloatArrayDataBuffer,
              csound: csoundInstance,
            });

            await startPromise;
            return startResult;
          };

          csoundStart.toString = () => reference.toString();
          this.exportApi.start = csoundStart.bind(this);
          break;
        }

        case "csoundStop": {
          const csoundStop = async () => {
            logSAB(
              "Checking if it's safe to call stop:",
              stopableStates.has(this.currentPlayState),
            );

            if (stopableStates.has(this.currentPlayState)) {
              logSAB("Marking SAB's state to STOP");
              const stopPromise = new Promise((resolve) => {
                this.stopPromiz = resolve;
              });
              Atomics.store(this.audioStatePointer, AUDIO_STATE.STOP, 1);
              logSAB("Marking that performance is not running anymore (stops the audio too)");
              Atomics.store(this.audioStatePointer, AUDIO_STATE.IS_PERFORMING, 0);

              // A potential case where the thread is locked because of pause
              if (this.currentPlayState === "realtimePerformancePaused") {
                Atomics.store(this.audioStatePointer, AUDIO_STATE.IS_PAUSED, 0);
                Atomics.notify(this.audioStatePointer, AUDIO_STATE.IS_PAUSED);
              }
              if (this.currentPlayState !== "renderStarted") {
                Atomics.store(this.audioStatePointer, AUDIO_STATE.ATOMIC_NOFITY, 1);
                Atomics.notify(this.audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY);
              }
              await stopPromise;
              return 0;
            } else {
              return -1;
            }
          };
          this.exportApi.stop = csoundStop.bind(this);
          csoundStop.toString = () => reference.toString();
          break;
        }

        case "csoundReset": {
          const csoundReset = async () => {
            if (stopableStates.has(this.currentPlayState)) {
              await this.exportApi.stop();
            }
            const resetResult = await proxyCallback([]);
            this.audioStateBuffer = new SharedArrayBuffer(
              initialSharedState.length * Int32Array.BYTES_PER_ELEMENT,
            );
            this.audioStatePointer = new Int32Array(this.audioStateBuffer);
            return resetResult;
          };
          this.exportApi.reset = csoundReset.bind(this);
          csoundReset.toString = () => reference.toString();
          break;
        }

        default: {
          const perfCallback = makeSABPerfCallback({
            apiK,
            audioStatePointer,
            callbackBuffer,
            callbackStringDataBuffer,
            callbackFloatArrayDataBuffer,
            returnQueue,
          });
          const bufferWrappedCallback = async (...args) => {
            if (
              this.currentPlayState === "realtimePerformanceStarted" ||
              this.currentPlayState === "renderStarted"
            ) {
              return await perfCallback(args);
            } else {
              return await proxyCallback.apply(undefined, args);
            }
          };
          bufferWrappedCallback.toString = () => reference.toString();
          this.exportApi[csoundApiRename(apiK)] = bufferWrappedCallback;
          break;
        }
      }
    }
    logSAB(`PUBLIC API Generated and stored`);
  }
}

export default SharedArrayBufferMainThread;
