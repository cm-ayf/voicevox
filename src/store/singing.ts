import path from "path";
import { toRaw } from "vue";
import { createDotNotationPartialStore as createPartialStore } from "./vuex";
import { createDotNotationUILockAction as createUILockAction } from "./ui";
import {
  Tempo,
  TimeSignature,
  Note,
  SingingStoreState,
  SingingStoreTypes,
  SingingCommandStoreState,
  SingingCommandStoreTypes,
  SaveResultObject,
  Singer,
  Phrase,
  transformCommandStore,
  SingingGuide,
  SingingVoice,
  SingingGuideSourceHash,
  SingingVoiceSourceHash,
  SequencerEditTarget,
  PhraseSourceHash,
  Track,
  SequenceId,
} from "./type";
import { DEFAULT_PROJECT_NAME, sanitizeFileName } from "./utility";
import {
  CharacterInfo,
  EngineId,
  NoteId,
  StyleId,
  TrackId,
} from "@/type/preload";
import { FrameAudioQuery, Note as NoteForRequestToEngine } from "@/openapi";
import { ResultError, getValueOrThrow } from "@/type/result";
import {
  AudioEvent,
  AudioPlayer,
  AudioSequence,
  ChannelStrip,
  Clipper,
  Limiter,
  NoteEvent,
  OfflineTransport,
  PolySynth,
  Sequence,
  Transport,
} from "@/sing/audioRendering";
import {
  selectPriorPhrase,
  getNoteDuration,
  isValidNote,
  isValidSnapType,
  isValidTempo,
  isValidTimeSignature,
  isValidKeyRangeAdjustment,
  isValidVolumeRangeAdjustment,
  secondToTick,
  tickToSecond,
  calculateSingingGuideSourceHash,
  calculateSingingVoiceSourceHash,
  decibelToLinear,
  applyPitchEdit,
  VALUE_INDICATING_NO_DATA,
  isValidPitchEditData,
  calculatePhraseSourceHash,
  isValidTempos,
  isValidTimeSignatures,
  isValidTpqn,
  DEFAULT_TPQN,
  DEPRECATED_DEFAULT_EDIT_FRAME_RATE,
  createDefaultTrack,
  createDefaultTempo,
  createDefaultTimeSignature,
  isValidNotes,
  isValidTrack,
  SEQUENCER_MIN_NUM_MEASURES,
  getNumMeasures,
  isTracksEmpty,
  shouldPlayTracks,
} from "@/sing/domain";
import {
  FrequentlyUpdatedState,
  getOverlappingNoteIds,
} from "@/sing/storeHelper";
import {
  AnimationTimer,
  createPromiseThatResolvesWhen,
  linearInterpolation,
  round,
} from "@/sing/utility";
import { getWorkaroundKeyRangeAdjustment } from "@/sing/workaroundKeyRangeAdjustment";
import { createLogger } from "@/domain/frontend/log";
import { noteSchema } from "@/domain/project/schema";
import { getOrThrow } from "@/helpers/mapHelper";
import { cloneWithUnwrapProxy } from "@/helpers/cloneWithUnwrapProxy";
import { ufProjectToVoicevox } from "@/sing/utaformatixProject/toVoicevox";
import { uuid4 } from "@/helpers/random";
import { convertToWavFileData } from "@/sing/convertToWavFileData";
import { generateWriteErrorMessage } from "@/helpers/fileHelper";

const logger = createLogger("store/singing");

const generateAudioEvents = async (
  audioContext: BaseAudioContext,
  time: number,
  blob: Blob,
): Promise<AudioEvent[]> => {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = await audioContext.decodeAudioData(arrayBuffer);
  return [{ time, buffer }];
};

const generateNoteEvents = (notes: Note[], tempos: Tempo[], tpqn: number) => {
  return notes.map((value): NoteEvent => {
    const noteOnPos = value.position;
    const noteOffPos = value.position + value.duration;
    return {
      noteNumber: value.noteNumber,
      noteOnTime: tickToSecond(noteOnPos, tempos, tpqn),
      noteOffTime: tickToSecond(noteOffPos, tempos, tpqn),
    };
  });
};

const generateDefaultSongFileName = (
  projectName: string | undefined,
  selectedTrack: Track,
  getCharacterInfo: (
    engineId: EngineId,
    styleId: StyleId,
  ) => CharacterInfo | undefined,
) => {
  if (projectName) {
    return projectName + ".wav";
  }

  const singer = selectedTrack.singer;
  if (singer) {
    const singerName = getCharacterInfo(singer.engineId, singer.styleId)?.metas
      .speakerName;
    if (singerName) {
      const notes = selectedTrack.notes.slice(0, 5);
      const beginningPartLyrics = notes.map((note) => note.lyric).join("");
      return sanitizeFileName(`${singerName}_${beginningPartLyrics}.wav`);
    }
  }

  return `${DEFAULT_PROJECT_NAME}.wav`;
};

const offlineRenderTracks = async (
  numberOfChannels: number,
  sampleRate: number,
  renderDuration: number,
  withLimiter: boolean,
  multiTrackEnabled: boolean,
  tracks: Map<TrackId, Track>,
  phrases: Map<PhraseSourceHash, Phrase>,
  singingGuides: Map<SingingGuideSourceHash, SingingGuide>,
  singingVoices: Map<SingingVoiceSourceHash, SingingVoice>,
) => {
  const offlineAudioContext = new OfflineAudioContext(
    numberOfChannels,
    sampleRate * renderDuration,
    sampleRate,
  );
  const offlineTransport = new OfflineTransport();
  const mainChannelStrip = new ChannelStrip(offlineAudioContext);
  const limiter = withLimiter ? new Limiter(offlineAudioContext) : undefined;
  const clipper = new Clipper(offlineAudioContext);
  const trackChannelStrips = new Map<TrackId, ChannelStrip>();
  const shouldPlays = shouldPlayTracks(tracks);
  for (const [trackId, track] of tracks) {
    const channelStrip = new ChannelStrip(offlineAudioContext);
    channelStrip.volume = multiTrackEnabled ? track.gain : 1;
    channelStrip.pan = multiTrackEnabled ? track.pan : 0;
    channelStrip.mute = multiTrackEnabled ? !shouldPlays.has(trackId) : false;

    channelStrip.output.connect(mainChannelStrip.input);
    trackChannelStrips.set(trackId, channelStrip);
  }

  for (const phrase of phrases.values()) {
    if (
      phrase.singingGuideKey == undefined ||
      phrase.singingVoiceKey == undefined ||
      phrase.state !== "PLAYABLE"
    ) {
      continue;
    }
    const singingGuide = getOrThrow(singingGuides, phrase.singingGuideKey);
    const singingVoice = getOrThrow(singingVoices, phrase.singingVoiceKey);

    // TODO: この辺りの処理を共通化する
    const audioEvents = await generateAudioEvents(
      offlineAudioContext,
      singingGuide.startTime,
      singingVoice.blob,
    );
    const audioPlayer = new AudioPlayer(offlineAudioContext);
    const audioSequence: AudioSequence = {
      type: "audio",
      audioPlayer,
      audioEvents,
    };
    const channelStrip = getOrThrow(trackChannelStrips, phrase.trackId);
    audioPlayer.output.connect(channelStrip.input);
    offlineTransport.addSequence(audioSequence);
  }
  mainChannelStrip.volume = 1;
  if (limiter) {
    mainChannelStrip.output.connect(limiter.input);
    limiter.output.connect(clipper.input);
  } else {
    mainChannelStrip.output.connect(clipper.input);
  }
  clipper.output.connect(offlineAudioContext.destination);

  // スケジューリングを行い、オフラインレンダリングを実行
  // TODO: オフラインレンダリング後にメモリーがきちんと開放されるか確認する
  offlineTransport.schedule(0, renderDuration);
  const audioBuffer = await offlineAudioContext.startRendering();

  return audioBuffer;
};

let audioContext: AudioContext | undefined;
let transport: Transport | undefined;
let previewSynth: PolySynth | undefined;
let mainChannelStrip: ChannelStrip | undefined;
const trackChannelStrips = new Map<TrackId, ChannelStrip>();
let limiter: Limiter | undefined;
let clipper: Clipper | undefined;

// NOTE: テスト時はAudioContextが存在しない
if (window.AudioContext) {
  audioContext = new AudioContext();
  transport = new Transport(audioContext);
  previewSynth = new PolySynth(audioContext);
  mainChannelStrip = new ChannelStrip(audioContext);
  limiter = new Limiter(audioContext);
  clipper = new Clipper(audioContext);

  previewSynth.output.connect(mainChannelStrip.input);
  mainChannelStrip.output.connect(limiter.input);
  limiter.output.connect(clipper.input);
  clipper.output.connect(audioContext.destination);
}

const playheadPosition = new FrequentlyUpdatedState(0);
const singingVoices = new Map<SingingVoiceSourceHash, SingingVoice>();
const sequences = new Map<SequenceId, Sequence & { trackId: TrackId }>();
const animationTimer = new AnimationTimer();

const singingGuideCache = new Map<SingingGuideSourceHash, SingingGuide>();
const singingVoiceCache = new Map<SingingVoiceSourceHash, SingingVoice>();

const initialTrackId = TrackId(crypto.randomUUID());

/**
 * シーケンスの音源の出力を取得する。
 * @param sequence シーケンス
 * @returns シーケンスの音源の出力
 */
const getOutputOfAudioSource = (sequence: Sequence) => {
  if (sequence.type === "note") {
    return sequence.instrument.output;
  } else if (sequence.type === "audio") {
    return sequence.audioPlayer.output;
  } else {
    throw new Error("Unknown type of sequence.");
  }
};

/**
 * シーケンスを登録する。
 * ChannelStripが存在する場合は、ChannelStripにシーケンスを接続する。
 * @param sequenceId シーケンスID
 * @param sequence トラックIDを持つシーケンス
 */
const registerSequence = (
  sequenceId: SequenceId,
  sequence: Sequence & { trackId: TrackId },
) => {
  if (transport == undefined) {
    throw new Error("transport is undefined.");
  }
  if (sequences.has(sequenceId)) {
    throw new Error("Sequence already exists.");
  }
  sequences.set(sequenceId, sequence);

  // Transportに追加する
  transport.addSequence(sequence);

  // ChannelStripがある場合は接続する
  const channelStrip = trackChannelStrips.get(sequence.trackId);
  if (channelStrip != undefined) {
    getOutputOfAudioSource(sequence).connect(channelStrip.input);
  }
};

/**
 * シーケンスを削除する。
 * ChannelStripが存在する場合は、ChannelStripとシーケンスの接続を解除する。
 * @param sequenceId シーケンスID
 */
const deleteSequence = (sequenceId: SequenceId) => {
  if (transport == undefined) {
    throw new Error("transport is undefined.");
  }
  const sequence = sequences.get(sequenceId);
  if (sequence == undefined) {
    throw new Error("Sequence does not exist.");
  }
  sequences.delete(sequenceId);

  // Transportから削除する
  transport.removeSequence(sequence);

  // ChannelStripがある場合は接続を解除する
  if (trackChannelStrips.has(sequence.trackId)) {
    getOutputOfAudioSource(sequence).disconnect();
  }
};

/**
 * `tracks`と`trackChannelStrips`を同期する。
 * シーケンスが存在する場合は、ChannelStripとシーケンスの接続・接続の解除を行う。
 * @param tracks `state`の`tracks`
 * @param enableMultiTrack マルチトラックが有効かどうか
 */
const syncTracksAndTrackChannelStrips = (
  tracks: Map<TrackId, Track>,
  enableMultiTrack: boolean,
) => {
  if (audioContext == undefined) {
    throw new Error("audioContext is undefined.");
  }
  if (mainChannelStrip == undefined) {
    throw new Error("mainChannelStrip is undefined.");
  }

  const shouldPlays = shouldPlayTracks(tracks);
  for (const [trackId, track] of tracks) {
    if (!trackChannelStrips.has(trackId)) {
      const channelStrip = new ChannelStrip(audioContext);
      channelStrip.output.connect(mainChannelStrip.input);
      trackChannelStrips.set(trackId, channelStrip);

      // シーケンスがある場合は、それらを接続する
      for (const [sequenceId, sequence] of sequences) {
        if (trackId === sequence.trackId) {
          const sequence = sequences.get(sequenceId);
          if (sequence == undefined) {
            throw new Error("Sequence does not exist.");
          }
          getOutputOfAudioSource(sequence).connect(channelStrip.input);
        }
      }
    }

    const channelStrip = getOrThrow(trackChannelStrips, trackId);
    if (enableMultiTrack) {
      channelStrip.volume = track.gain;
      channelStrip.pan = track.pan;
      channelStrip.mute = !shouldPlays.has(trackId);
    } else {
      channelStrip.volume = 1;
      channelStrip.pan = 0;
      channelStrip.mute = false;
    }
  }
  for (const [trackId, channelStrip] of trackChannelStrips) {
    if (!tracks.has(trackId)) {
      channelStrip.output.disconnect();
      trackChannelStrips.delete(trackId);

      // シーケンスがある場合は、それらの接続を解除する
      for (const [sequenceId, sequence] of sequences) {
        if (trackId === sequence.trackId) {
          const sequence = sequences.get(sequenceId);
          if (sequence == undefined) {
            throw new Error("Sequence does not exist.");
          }
          getOutputOfAudioSource(sequence).disconnect();
        }
      }
    }
  }
};

/** トラックを取得する。見付からないときはフォールバックとして最初のトラックを返す。 */
const getSelectedTrackWithFallback = (partialState: {
  tracks: Map<TrackId, Track>;
  _selectedTrackId: TrackId;
  trackOrder: TrackId[];
}) => {
  if (!partialState.tracks.has(partialState._selectedTrackId)) {
    return getOrThrow(partialState.tracks, partialState.trackOrder[0]);
  }
  return getOrThrow(partialState.tracks, partialState._selectedTrackId);
};

export const singingStoreState: SingingStoreState = {
  tpqn: DEFAULT_TPQN,
  tempos: [createDefaultTempo(0)],
  timeSignatures: [createDefaultTimeSignature(1)],
  tracks: new Map([[initialTrackId, createDefaultTrack()]]),
  trackOrder: [initialTrackId],

  /**
   * 選択中のトラックID。
   * NOTE: このトラックIDは存在しない場合がある（Undo/Redoがあるため）。
   * 可能な限りgetters.SELECTED_TRACK_IDを使うこと。getSelectedTrackWithFallbackも参照。
   */
  _selectedTrackId: initialTrackId,

  editFrameRate: DEPRECATED_DEFAULT_EDIT_FRAME_RATE,
  phrases: new Map(),
  singingGuides: new Map(),
  sequencerZoomX: 0.5,
  sequencerZoomY: 0.75,
  sequencerSnapType: 16,
  sequencerEditTarget: "NOTE",
  _selectedNoteIds: new Set(),
  nowPlaying: false,
  volume: 0,
  startRenderingRequested: false,
  stopRenderingRequested: false,
  nowRendering: false,
  nowAudioExporting: false,
  cancellationOfAudioExportRequested: false,
  isSongSidebarOpen: false,
};

export const singingStore = createPartialStore<SingingStoreTypes>({
  SELECTED_TRACK_ID: {
    getter(state) {
      // Undo/Redoで消えている場合は最初のトラックを選択していることにする
      if (!state.tracks.has(state._selectedTrackId)) {
        return state.trackOrder[0];
      }
      return state._selectedTrackId;
    },
  },

  SELECTED_NOTE_IDS: {
    // 選択中のトラックのノートだけを選択中のノートとして返す。
    getter(state) {
      const selectedTrack = getSelectedTrackWithFallback(state);

      const noteIdsInSelectedTrack = new Set(
        selectedTrack.notes.map((note) => note.id),
      );

      // そのままSet#intersectionを呼ぶとVueのバグでエラーになるため、new Set()でProxyなしのSetを作成する
      // TODO: https://github.com/vuejs/core/issues/11398 が解決したら修正する
      return new Set(state._selectedNoteIds).intersection(
        noteIdsInSelectedTrack,
      );
    },
  },

  SETUP_SINGER: {
    async action({ actions }, { singer }: { singer: Singer }) {
      // 指定されたstyleIdに対して、エンジン側の初期化を行う
      const isInitialized = await actions.IS_INITIALIZED_ENGINE_SPEAKER(singer);
      if (!isInitialized) {
        await actions.INITIALIZE_ENGINE_SPEAKER(singer);
      }
    },
  },

  SET_SINGER: {
    // 歌手をセットする。
    // withRelatedがtrueの場合、関連する情報もセットする。
    mutation(state, { singer, withRelated, trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      track.singer = singer;

      if (withRelated == true && singer != undefined) {
        // 音域調整量マジックナンバーを設定するワークアラウンド
        const keyRangeAdjustment = getWorkaroundKeyRangeAdjustment(
          state.characterInfos,
          singer,
        );
        track.keyRangeAdjustment = keyRangeAdjustment;
      }
    },
    async action(
      { state, getters, actions, mutations },
      { singer, withRelated, trackId },
    ) {
      if (state.defaultStyleIds == undefined)
        throw new Error("state.defaultStyleIds == undefined");
      const userOrderedCharacterInfos =
        getters.USER_ORDERED_CHARACTER_INFOS("singerLike");
      if (userOrderedCharacterInfos == undefined)
        throw new Error("userOrderedCharacterInfos == undefined");

      const engineId = singer?.engineId ?? state.engineIds[0];

      const defaultStyleId =
        userOrderedCharacterInfos[0].metas.styles[0].styleId;
      const styleId = singer?.styleId ?? defaultStyleId;

      void actions.SETUP_SINGER({ singer: { engineId, styleId } });
      mutations.SET_SINGER({
        singer: { engineId, styleId },
        withRelated,
        trackId,
      });

      void actions.RENDER();
    },
  },

  SET_KEY_RANGE_ADJUSTMENT: {
    mutation(state, { keyRangeAdjustment, trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      track.keyRangeAdjustment = keyRangeAdjustment;
    },
    async action({ actions, mutations }, { keyRangeAdjustment, trackId }) {
      if (!isValidKeyRangeAdjustment(keyRangeAdjustment)) {
        throw new Error("The keyRangeAdjustment is invalid.");
      }
      mutations.SET_KEY_RANGE_ADJUSTMENT({ keyRangeAdjustment, trackId });

      void actions.RENDER();
    },
  },

  SET_VOLUME_RANGE_ADJUSTMENT: {
    mutation(state, { volumeRangeAdjustment, trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      track.volumeRangeAdjustment = volumeRangeAdjustment;
    },
    async action({ actions, mutations }, { volumeRangeAdjustment, trackId }) {
      if (!isValidVolumeRangeAdjustment(volumeRangeAdjustment)) {
        throw new Error("The volumeRangeAdjustment is invalid.");
      }
      mutations.SET_VOLUME_RANGE_ADJUSTMENT({
        volumeRangeAdjustment,
        trackId,
      });

      void actions.RENDER();
    },
  },

  SET_TPQN: {
    mutation(state, { tpqn }: { tpqn: number }) {
      state.tpqn = tpqn;
    },
    async action(
      { state, getters, mutations, actions },
      { tpqn }: { tpqn: number },
    ) {
      if (!isValidTpqn(tpqn)) {
        throw new Error("The tpqn is invalid.");
      }
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      if (state.nowPlaying) {
        await actions.SING_STOP_AUDIO();
      }
      mutations.SET_TPQN({ tpqn });
      transport.time = getters.TICK_TO_SECOND(playheadPosition.value);

      void actions.RENDER();
    },
  },

  SET_TEMPOS: {
    mutation(state, { tempos }: { tempos: Tempo[] }) {
      state.tempos = tempos;
    },
    async action(
      { state, getters, mutations, actions },
      { tempos }: { tempos: Tempo[] },
    ) {
      if (!isValidTempos(tempos)) {
        throw new Error("The tempos are invalid.");
      }
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      if (state.nowPlaying) {
        await actions.SING_STOP_AUDIO();
      }
      mutations.SET_TEMPOS({ tempos });
      transport.time = getters.TICK_TO_SECOND(playheadPosition.value);

      void actions.RENDER();
    },
  },

  SET_TEMPO: {
    mutation(state, { tempo }: { tempo: Tempo }) {
      const index = state.tempos.findIndex((value) => {
        return value.position === tempo.position;
      });
      const tempos = [...state.tempos];
      if (index !== -1) {
        tempos.splice(index, 1, tempo);
      } else {
        tempos.push(tempo);
        tempos.sort((a, b) => a.position - b.position);
      }
      state.tempos = tempos;
    },
  },

  REMOVE_TEMPO: {
    mutation(state, { position }: { position: number }) {
      const index = state.tempos.findIndex((value) => {
        return value.position === position;
      });
      if (index === -1) {
        throw new Error("The tempo does not exist.");
      }
      const tempos = [...state.tempos];
      if (index === 0) {
        tempos.splice(index, 1, createDefaultTempo(0));
      } else {
        tempos.splice(index, 1);
      }
      state.tempos = tempos;
    },
  },

  SET_TIME_SIGNATURES: {
    mutation(state, { timeSignatures }: { timeSignatures: TimeSignature[] }) {
      state.timeSignatures = timeSignatures;
    },
    async action(
      { mutations },
      { timeSignatures }: { timeSignatures: TimeSignature[] },
    ) {
      if (!isValidTimeSignatures(timeSignatures)) {
        throw new Error("The time signatures are invalid.");
      }
      mutations.SET_TIME_SIGNATURES({ timeSignatures });
    },
  },

  SET_TIME_SIGNATURE: {
    mutation(state, { timeSignature }: { timeSignature: TimeSignature }) {
      const index = state.timeSignatures.findIndex((value) => {
        return value.measureNumber === timeSignature.measureNumber;
      });
      const timeSignatures = [...state.timeSignatures];
      if (index !== -1) {
        timeSignatures.splice(index, 1, timeSignature);
      } else {
        timeSignatures.push(timeSignature);
        timeSignatures.sort((a, b) => a.measureNumber - b.measureNumber);
      }
      state.timeSignatures = timeSignatures;
    },
  },

  REMOVE_TIME_SIGNATURE: {
    mutation(state, { measureNumber }: { measureNumber: number }) {
      const index = state.timeSignatures.findIndex((value) => {
        return value.measureNumber === measureNumber;
      });
      if (index === -1) {
        throw new Error("The time signature does not exist.");
      }
      const timeSignatures = [...state.timeSignatures];
      if (index === 0) {
        timeSignatures.splice(index, 1, createDefaultTimeSignature(1));
      } else {
        timeSignatures.splice(index, 1);
      }
      state.timeSignatures = timeSignatures;
    },
  },

  ALL_NOTE_IDS: {
    getter(state) {
      const noteIds = [...state.tracks.values()].flatMap((track) =>
        track.notes.map((note) => note.id),
      );
      return new Set(noteIds);
    },
  },

  OVERLAPPING_NOTE_IDS: {
    getter: (state) => (trackId) => {
      const notes = getOrThrow(state.tracks, trackId).notes;
      return getOverlappingNoteIds(notes);
    },
  },

  SET_NOTES: {
    mutation(state, { notes, trackId }) {
      state.editingLyricNoteId = undefined;
      state._selectedNoteIds.clear();
      const selectedTrack = getOrThrow(state.tracks, trackId);
      selectedTrack.notes = notes;
    },
    async action({ mutations, actions }, { notes, trackId }) {
      if (!isValidNotes(notes)) {
        throw new Error("The notes are invalid.");
      }
      mutations.SET_NOTES({ notes, trackId });

      void actions.RENDER();
    },
  },

  ADD_NOTES: {
    mutation(state, { notes, trackId }) {
      const selectedTrack = getOrThrow(state.tracks, trackId);
      const newNotes = [...selectedTrack.notes, ...notes];
      newNotes.sort((a, b) => a.position - b.position);
      selectedTrack.notes = newNotes;
    },
  },

  UPDATE_NOTES: {
    mutation(state, { notes, trackId }) {
      const notesMap = new Map<NoteId, Note>();
      for (const note of notes) {
        notesMap.set(note.id, note);
      }
      const selectedTrack = getOrThrow(state.tracks, trackId);
      selectedTrack.notes = selectedTrack.notes
        .map((value) => notesMap.get(value.id) ?? value)
        .sort((a, b) => a.position - b.position);
    },
  },

  REMOVE_NOTES: {
    mutation(state, { noteIds, trackId }) {
      const noteIdsSet = new Set(noteIds);
      const selectedTrack = getOrThrow(state.tracks, trackId);
      if (
        state.editingLyricNoteId != undefined &&
        noteIdsSet.has(state.editingLyricNoteId)
      ) {
        state.editingLyricNoteId = undefined;
      }
      for (const noteId of noteIds) {
        state._selectedNoteIds.delete(noteId);
      }
      selectedTrack.notes = selectedTrack.notes.filter((value) => {
        return !noteIdsSet.has(value.id);
      });
    },
  },

  SELECT_NOTES: {
    mutation(state, { noteIds }: { noteIds: NoteId[] }) {
      for (const noteId of noteIds) {
        state._selectedNoteIds.add(noteId);
      }
    },
    async action({ getters, mutations }, { noteIds }: { noteIds: NoteId[] }) {
      const existingNoteIds = getters.ALL_NOTE_IDS;
      const isValidNoteIds = noteIds.every((value) => {
        return existingNoteIds.has(value);
      });
      if (!isValidNoteIds) {
        throw new Error("The note ids are invalid.");
      }
      mutations.SELECT_NOTES({ noteIds });
    },
  },

  SELECT_ALL_NOTES_IN_TRACK: {
    async action({ state, mutations }, { trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      const noteIds = track.notes.map((note) => note.id);
      mutations.DESELECT_ALL_NOTES();
      mutations.SELECT_NOTES({ noteIds });
    },
  },

  DESELECT_ALL_NOTES: {
    mutation(state) {
      state.editingLyricNoteId = undefined;
      state._selectedNoteIds = new Set();
    },
    async action({ mutations }) {
      mutations.DESELECT_ALL_NOTES();
    },
  },

  SET_EDITING_LYRIC_NOTE_ID: {
    mutation(state, { noteId }: { noteId?: NoteId }) {
      if (noteId != undefined && !state._selectedNoteIds.has(noteId)) {
        state._selectedNoteIds.clear();
        state._selectedNoteIds.add(noteId);
      }
      state.editingLyricNoteId = noteId;
    },
    async action({ getters, mutations }, { noteId }: { noteId?: NoteId }) {
      if (noteId != undefined && !getters.ALL_NOTE_IDS.has(noteId)) {
        throw new Error("The note id is invalid.");
      }
      mutations.SET_EDITING_LYRIC_NOTE_ID({ noteId });
    },
  },

  SET_PITCH_EDIT_DATA: {
    // ピッチ編集データをセットする。
    // track.pitchEditDataの長さが足りない場合は、伸長も行う。
    mutation(state, { pitchArray, startFrame, trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      const pitchEditData = track.pitchEditData;
      const tempData = [...pitchEditData];
      const endFrame = startFrame + pitchArray.length;
      if (tempData.length < endFrame) {
        const valuesToPush = new Array<number>(endFrame - tempData.length).fill(
          VALUE_INDICATING_NO_DATA,
        );
        tempData.push(...valuesToPush);
      }
      tempData.splice(startFrame, pitchArray.length, ...pitchArray);
      track.pitchEditData = tempData;
    },
    async action({ actions, mutations }, { pitchArray, startFrame, trackId }) {
      if (startFrame < 0) {
        throw new Error("startFrame must be greater than or equal to 0.");
      }
      if (!isValidPitchEditData(pitchArray)) {
        throw new Error("The pitch edit data is invalid.");
      }
      mutations.SET_PITCH_EDIT_DATA({ pitchArray, startFrame, trackId });

      void actions.RENDER();
    },
  },

  ERASE_PITCH_EDIT_DATA: {
    mutation(state, { startFrame, frameLength, trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      const pitchEditData = track.pitchEditData;
      const tempData = [...pitchEditData];
      const endFrame = Math.min(startFrame + frameLength, tempData.length);
      tempData.fill(VALUE_INDICATING_NO_DATA, startFrame, endFrame);
      track.pitchEditData = tempData;
    },
  },

  CLEAR_PITCH_EDIT_DATA: {
    // ピッチ編集データを失くす。
    mutation(state, { trackId }) {
      const track = getOrThrow(state.tracks, trackId);
      track.pitchEditData = [];
    },
    async action({ actions, mutations }, { trackId }) {
      mutations.CLEAR_PITCH_EDIT_DATA({ trackId });

      void actions.RENDER();
    },
  },

  SET_PHRASES: {
    mutation(state, { phrases }) {
      state.phrases = phrases;
    },
  },

  SET_STATE_TO_PHRASE: {
    mutation(state, { phraseKey, phraseState }) {
      const phrase = getOrThrow(state.phrases, phraseKey);

      phrase.state = phraseState;
    },
  },

  SET_SINGING_GUIDE_KEY_TO_PHRASE: {
    mutation(
      state,
      {
        phraseKey,
        singingGuideKey,
      }: {
        phraseKey: PhraseSourceHash;
        singingGuideKey: SingingGuideSourceHash | undefined;
      },
    ) {
      const phrase = getOrThrow(state.phrases, phraseKey);

      phrase.singingGuideKey = singingGuideKey;
    },
  },

  SET_SINGING_VOICE_KEY_TO_PHRASE: {
    mutation(
      state,
      {
        phraseKey,
        singingVoiceKey,
      }: {
        phraseKey: PhraseSourceHash;
        singingVoiceKey: SingingVoiceSourceHash | undefined;
      },
    ) {
      const phrase = getOrThrow(state.phrases, phraseKey);

      phrase.singingVoiceKey = singingVoiceKey;
    },
  },

  SET_SEQUENCE_ID_TO_PHRASE: {
    mutation(
      state,
      {
        phraseKey,
        sequenceId,
      }: {
        phraseKey: PhraseSourceHash;
        sequenceId: SequenceId | undefined;
      },
    ) {
      const phrase = getOrThrow(state.phrases, phraseKey);

      phrase.sequenceId = sequenceId;
    },
  },

  SET_SINGING_GUIDE: {
    mutation(
      state,
      {
        singingGuideKey,
        singingGuide,
      }: {
        singingGuideKey: SingingGuideSourceHash;
        singingGuide: SingingGuide;
      },
    ) {
      state.singingGuides.set(singingGuideKey, singingGuide);
    },
  },

  DELETE_SINGING_GUIDE: {
    mutation(
      state,
      { singingGuideKey }: { singingGuideKey: SingingGuideSourceHash },
    ) {
      state.singingGuides.delete(singingGuideKey);
    },
  },

  SELECTED_TRACK: {
    getter(state) {
      return getSelectedTrackWithFallback(state);
    },
  },

  SET_SNAP_TYPE: {
    mutation(state, { snapType }) {
      state.sequencerSnapType = snapType;
    },
    async action({ state, mutations }, { snapType }) {
      const tpqn = state.tpqn;
      if (!isValidSnapType(snapType, tpqn)) {
        throw new Error("The snap type is invalid.");
      }
      mutations.SET_SNAP_TYPE({ snapType });
    },
  },

  SEQUENCER_NUM_MEASURES: {
    getter(state) {
      // NOTE: スコア長(曲長さ)が決まっていないため、無限スクロール化する or 最後尾に足した場合は伸びるようにするなど？
      // NOTE: いったん最後尾に足した場合は伸びるようにする
      return Math.max(
        SEQUENCER_MIN_NUM_MEASURES,
        getNumMeasures(
          [...state.tracks.values()].flatMap((track) => track.notes),
          state.tempos,
          state.timeSignatures,
          state.tpqn,
        ) + 1,
      );
    },
  },

  SET_ZOOM_X: {
    mutation(state, { zoomX }: { zoomX: number }) {
      state.sequencerZoomX = zoomX;
    },
    async action({ mutations }, { zoomX }) {
      mutations.SET_ZOOM_X({ zoomX });
    },
  },

  SET_ZOOM_Y: {
    mutation(state, { zoomY }: { zoomY: number }) {
      state.sequencerZoomY = zoomY;
    },
    async action({ mutations }, { zoomY }) {
      mutations.SET_ZOOM_Y({ zoomY });
    },
  },

  SET_EDIT_TARGET: {
    mutation(state, { editTarget }: { editTarget: SequencerEditTarget }) {
      state.sequencerEditTarget = editTarget;
    },
    async action(
      { mutations },
      { editTarget }: { editTarget: SequencerEditTarget },
    ) {
      mutations.SET_EDIT_TARGET({ editTarget });
    },
  },

  TICK_TO_SECOND: {
    getter: (state) => (position) => {
      return tickToSecond(position, state.tempos, state.tpqn);
    },
  },

  SECOND_TO_TICK: {
    getter: (state) => (time) => {
      return secondToTick(time, state.tempos, state.tpqn);
    },
  },

  GET_PLAYHEAD_POSITION: {
    getter: (state, getters) => () => {
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      if (state.nowPlaying) {
        playheadPosition.value = getters.SECOND_TO_TICK(transport.time);
      }
      return playheadPosition.value;
    },
  },

  SET_PLAYHEAD_POSITION: {
    async action({ getters }, { position }: { position: number }) {
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      playheadPosition.value = position;
      transport.time = getters.TICK_TO_SECOND(position);
    },
  },

  ADD_PLAYHEAD_POSITION_CHANGE_LISTENER: {
    async action(_, { listener }: { listener: (position: number) => void }) {
      playheadPosition.addValueChangeListener(listener);
    },
  },

  REMOVE_PLAYHEAD_POSITION_CHANGE_LISTENER: {
    async action(_, { listener }: { listener: (position: number) => void }) {
      playheadPosition.removeValueChangeListener(listener);
    },
  },

  SET_PLAYBACK_STATE: {
    mutation(state, { nowPlaying }) {
      state.nowPlaying = nowPlaying;
    },
  },

  SING_PLAY_AUDIO: {
    async action({ state, getters, mutations }) {
      if (state.nowPlaying) {
        return;
      }
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      mutations.SET_PLAYBACK_STATE({ nowPlaying: true });

      transport.start();
      animationTimer.start(() => {
        playheadPosition.value = getters.GET_PLAYHEAD_POSITION();
      });
    },
  },

  SING_STOP_AUDIO: {
    async action({ state, getters, mutations }) {
      if (!state.nowPlaying) {
        return;
      }
      if (!transport) {
        throw new Error("transport is undefined.");
      }
      mutations.SET_PLAYBACK_STATE({ nowPlaying: false });

      transport.stop();
      animationTimer.stop();
      playheadPosition.value = getters.GET_PLAYHEAD_POSITION();
    },
  },

  SET_VOLUME: {
    mutation(state, { volume }) {
      state.volume = volume;
    },
    async action({ mutations }, { volume }) {
      if (!mainChannelStrip) {
        throw new Error("channelStrip is undefined.");
      }
      mutations.SET_VOLUME({ volume });

      mainChannelStrip.volume = volume;
    },
  },

  PLAY_PREVIEW_SOUND: {
    async action(
      _,
      { noteNumber, duration }: { noteNumber: number; duration?: number },
    ) {
      if (!audioContext) {
        throw new Error("audioContext is undefined.");
      }
      if (!previewSynth) {
        throw new Error("previewSynth is undefined.");
      }
      previewSynth.noteOn("immediately", noteNumber, duration);
    },
  },

  STOP_PREVIEW_SOUND: {
    async action(_, { noteNumber }: { noteNumber: number }) {
      if (!audioContext) {
        throw new Error("audioContext is undefined.");
      }
      if (!previewSynth) {
        throw new Error("previewSynth is undefined.");
      }
      previewSynth.noteOff("immediately", noteNumber);
    },
  },

  SET_IS_DRAG: {
    mutation(state, { isDrag }: { isDrag: boolean }) {
      state.isDrag = isDrag;
    },
    async action({ mutations }, { isDrag }) {
      mutations.SET_IS_DRAG({
        isDrag,
      });
    },
  },

  SET_START_RENDERING_REQUESTED: {
    mutation(state, { startRenderingRequested }) {
      state.startRenderingRequested = startRenderingRequested;
    },
  },

  SET_STOP_RENDERING_REQUESTED: {
    mutation(state, { stopRenderingRequested }) {
      state.stopRenderingRequested = stopRenderingRequested;
    },
  },

  SET_NOW_RENDERING: {
    mutation(state, { nowRendering }) {
      state.nowRendering = nowRendering;
    },
  },

  CREATE_TRACK: {
    action() {
      const trackId = TrackId(crypto.randomUUID());
      const track = createDefaultTrack();

      return { trackId, track };
    },
  },

  INSERT_TRACK: {
    /**
     * トラックを挿入する。
     * prevTrackIdがundefinedの場合は最後に追加する。
     */
    mutation(state, { trackId, track, prevTrackId }) {
      const index =
        prevTrackId != undefined
          ? state.trackOrder.indexOf(prevTrackId) + 1
          : state.trackOrder.length;
      state.tracks.set(trackId, track);
      state.trackOrder.splice(index, 0, trackId);
    },
    action({ state, mutations, actions }, { trackId, track, prevTrackId }) {
      if (state.tracks.has(trackId)) {
        throw new Error(`Track ${trackId} is already registered.`);
      }
      if (!isValidTrack(track)) {
        throw new Error("The track is invalid.");
      }
      mutations.INSERT_TRACK({ trackId, track, prevTrackId });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      void actions.RENDER();
    },
  },

  DELETE_TRACK: {
    mutation(state, { trackId }) {
      state.tracks.delete(trackId);
      state.trackOrder = state.trackOrder.filter((value) => value !== trackId);
    },
    async action({ state, mutations, actions }, { trackId }) {
      if (!state.tracks.has(trackId)) {
        throw new Error(`Track ${trackId} does not exist.`);
      }
      mutations.DELETE_TRACK({ trackId });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      void actions.RENDER();
    },
  },

  SELECT_TRACK: {
    // トラックを切り替えるときに選択中のノートをクリアする。
    mutation(state, { trackId }) {
      state._selectedNoteIds.clear();
      state._selectedTrackId = trackId;
    },
    action({ state, mutations }, { trackId }) {
      if (!state.tracks.has(trackId)) {
        throw new Error(`Track ${trackId} does not exist.`);
      }
      mutations.SELECT_TRACK({ trackId });
    },
  },

  SET_TRACK: {
    mutation(state, { trackId, track }) {
      state.tracks.set(trackId, track);
    },
    async action({ state, mutations, actions }, { trackId, track }) {
      if (!isValidTrack(track)) {
        throw new Error("The track is invalid.");
      }
      if (!state.tracks.has(trackId)) {
        throw new Error(`Track ${trackId} does not exist.`);
      }

      mutations.SET_TRACK({ trackId, track });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      void actions.RENDER();
    },
  },

  SET_TRACKS: {
    mutation(state, { tracks }) {
      state.tracks = tracks;
      state.trackOrder = Array.from(tracks.keys());
    },
    async action({ mutations, actions }, { tracks }) {
      if (![...tracks.values()].every((track) => isValidTrack(track))) {
        throw new Error("The track is invalid.");
      }
      mutations.SET_TRACKS({ tracks });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      void actions.RENDER();
    },
  },

  SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS: {
    async action({ state }) {
      syncTracksAndTrackChannelStrips(
        state.tracks,
        state.experimentalSetting.enableMultiTrack,
      );
    },
  },

  /**
   * レンダリングを行う。レンダリング中だった場合は停止して再レンダリングする。
   */
  RENDER: {
    async action({ state, getters, mutations, actions }) {
      const calcPhraseFirstRestDuration = (
        prevPhraseLastNote: Note | undefined,
        phraseFirstNote: Note,
        phraseFirstRestMinDurationSeconds: number,
        tempos: Tempo[],
        tpqn: number,
      ) => {
        const quarterNoteDuration = getNoteDuration(4, tpqn);
        let phraseFirstRestDuration: number | undefined = undefined;

        // 実際のフレーズ先頭の休符の長さを調べる
        if (prevPhraseLastNote == undefined) {
          if (phraseFirstNote.position === 0) {
            // 1小節目の最初から始まっているフレーズの場合は、
            // とりあえず4分音符の長さをフレーズ先頭の休符の長さにする
            phraseFirstRestDuration = quarterNoteDuration;
          } else {
            phraseFirstRestDuration = phraseFirstNote.position;
          }
        } else {
          const prevPhraseLastNoteEndPos =
            prevPhraseLastNote.position + prevPhraseLastNote.duration;
          phraseFirstRestDuration =
            phraseFirstNote.position - prevPhraseLastNoteEndPos;
        }
        // 4分音符の長さ以下にする
        phraseFirstRestDuration = Math.min(
          phraseFirstRestDuration,
          quarterNoteDuration,
        );
        // 最小の長さ以上にする
        phraseFirstRestDuration = Math.max(
          phraseFirstRestDuration,
          phraseFirstNote.position -
            secondToTick(
              tickToSecond(phraseFirstNote.position, tempos, tpqn) -
                phraseFirstRestMinDurationSeconds,
              tempos,
              tpqn,
            ),
        );
        // 1tick以上にする
        phraseFirstRestDuration = Math.max(1, phraseFirstRestDuration);

        return phraseFirstRestDuration;
      };

      const searchPhrases = async (
        notes: Note[],
        tempos: Tempo[],
        tpqn: number,
        phraseFirstRestMinDurationSeconds: number,
        trackId: TrackId,
      ) => {
        const foundPhrases = new Map<PhraseSourceHash, Phrase>();

        let phraseNotes: Note[] = [];
        let prevPhraseLastNote: Note | undefined = undefined;

        for (let i = 0; i < notes.length; i++) {
          const note = notes[i];
          const nextNote = notes.at(i + 1);
          const currentNoteEndPos = note.position + note.duration;

          phraseNotes.push(note);

          // ノートが途切れていたら別のフレーズにする
          if (
            nextNote == undefined ||
            currentNoteEndPos !== nextNote.position
          ) {
            const phraseFirstNote = phraseNotes[0];
            const phraseFirstRestDuration = calcPhraseFirstRestDuration(
              prevPhraseLastNote,
              phraseFirstNote,
              phraseFirstRestMinDurationSeconds,
              tempos,
              tpqn,
            );
            const notesHash = await calculatePhraseSourceHash({
              firstRestDuration: phraseFirstRestDuration,
              notes: phraseNotes,
              trackId,
            });
            foundPhrases.set(notesHash, {
              firstRestDuration: phraseFirstRestDuration,
              notes: phraseNotes,
              state: "WAITING_TO_BE_RENDERED",
              trackId,
            });

            if (nextNote != undefined) {
              prevPhraseLastNote = phraseNotes.at(-1);
              phraseNotes = [];
            }
          }
        }
        return foundPhrases;
      };

      // リクエスト用のノーツ（と休符）を作成する
      const createNotesForRequestToEngine = (
        firstRestDuration: number,
        lastRestDurationSeconds: number,
        notes: Note[],
        tempos: Tempo[],
        tpqn: number,
        frameRate: number,
      ) => {
        const notesForRequestToEngine: NoteForRequestToEngine[] = [];

        // 先頭の休符を変換
        const firstRestStartSeconds = tickToSecond(
          notes[0].position - firstRestDuration,
          tempos,
          tpqn,
        );
        const firstRestStartFrame = Math.round(
          firstRestStartSeconds * frameRate,
        );
        const firstRestEndSeconds = tickToSecond(
          notes[0].position,
          tempos,
          tpqn,
        );
        const firstRestEndFrame = Math.round(firstRestEndSeconds * frameRate);
        notesForRequestToEngine.push({
          key: undefined,
          frameLength: firstRestEndFrame - firstRestStartFrame,
          lyric: "",
        });

        // ノートを変換
        for (const note of notes) {
          const noteOnSeconds = tickToSecond(note.position, tempos, tpqn);
          const noteOnFrame = Math.round(noteOnSeconds * frameRate);
          const noteOffSeconds = tickToSecond(
            note.position + note.duration,
            tempos,
            tpqn,
          );
          const noteOffFrame = Math.round(noteOffSeconds * frameRate);
          notesForRequestToEngine.push({
            key: note.noteNumber,
            frameLength: noteOffFrame - noteOnFrame,
            lyric: note.lyric,
          });
        }

        // 末尾に休符を追加
        const lastRestFrameLength = Math.round(
          lastRestDurationSeconds * frameRate,
        );
        notesForRequestToEngine.push({
          key: undefined,
          frameLength: lastRestFrameLength,
          lyric: "",
        });

        // frameLengthが1以上になるようにする
        for (let i = 0; i < notesForRequestToEngine.length; i++) {
          const frameLength = notesForRequestToEngine[i].frameLength;
          const frameToShift = Math.max(0, 1 - frameLength);
          notesForRequestToEngine[i].frameLength += frameToShift;
          if (i < notesForRequestToEngine.length - 1) {
            notesForRequestToEngine[i + 1].frameLength -= frameToShift;
          }
        }

        return notesForRequestToEngine;
      };

      const shiftKeyOfNotes = (
        notes: NoteForRequestToEngine[],
        keyShift: number,
      ) => {
        for (const note of notes) {
          if (note.key != undefined) {
            note.key += keyShift;
          }
        }
      };

      const singingTeacherStyleId = StyleId(6000); // TODO: 設定できるようにする

      const fetchQuery = async (
        engineId: EngineId,
        notesForRequestToEngine: NoteForRequestToEngine[],
      ) => {
        try {
          if (!getters.IS_ENGINE_READY(engineId)) {
            throw new Error("Engine not ready.");
          }
          const instance = await actions.INSTANTIATE_ENGINE_CONNECTOR({
            engineId,
          });
          return await instance.invoke(
            "singFrameAudioQuerySingFrameAudioQueryPost",
          )({
            score: { notes: notesForRequestToEngine },
            speaker: singingTeacherStyleId,
          });
        } catch (error) {
          const lyrics = notesForRequestToEngine
            .map((value) => value.lyric)
            .join("");
          logger.error(
            `Failed to fetch FrameAudioQuery. Lyrics of score are "${lyrics}".`,
            error,
          );
          throw error;
        }
      };

      const getPhonemes = (frameAudioQuery: FrameAudioQuery) => {
        return frameAudioQuery.phonemes.map((value) => value.phoneme).join(" ");
      };

      const shiftGuidePitch = (
        frameAudioQuery: FrameAudioQuery,
        pitchShift: number,
      ) => {
        frameAudioQuery.f0 = frameAudioQuery.f0.map((value) => {
          return value * Math.pow(2, pitchShift / 12);
        });
      };

      const shiftGuideVolume = (
        frameAudioQuery: FrameAudioQuery,
        volumeShift: number,
      ) => {
        frameAudioQuery.volume = frameAudioQuery.volume.map((value) => {
          return value * decibelToLinear(volumeShift);
        });
      };

      // 歌とpauの呼吸音が重ならないようにvolumeを制御する
      // fadeOutDurationSecondsが0の場合は即座にvolumeを0にする
      const muteLastPauSection = (
        frameAudioQuery: FrameAudioQuery,
        frameRate: number,
        fadeOutDurationSeconds: number,
      ) => {
        const lastPhoneme = frameAudioQuery.phonemes.at(-1);
        if (lastPhoneme == undefined || lastPhoneme.phoneme !== "pau") {
          throw new Error("No pau exists at the end.");
        }

        let lastPauStartFrame = 0;
        for (let i = 0; i < frameAudioQuery.phonemes.length - 1; i++) {
          lastPauStartFrame += frameAudioQuery.phonemes[i].frameLength;
        }

        const lastPauFrameLength = lastPhoneme.frameLength;
        let fadeOutFrameLength = Math.round(fadeOutDurationSeconds * frameRate);
        fadeOutFrameLength = Math.max(0, fadeOutFrameLength);
        fadeOutFrameLength = Math.min(lastPauFrameLength, fadeOutFrameLength);

        // フェードアウト処理を行う
        if (fadeOutFrameLength === 1) {
          frameAudioQuery.volume[lastPauStartFrame] *= 0.5;
        } else {
          for (let i = 0; i < fadeOutFrameLength; i++) {
            frameAudioQuery.volume[lastPauStartFrame + i] *=
              linearInterpolation(0, 1, fadeOutFrameLength - 1, 0, i);
          }
        }
        // 音量を0にする
        for (let i = fadeOutFrameLength; i < lastPauFrameLength; i++) {
          frameAudioQuery.volume[lastPauStartFrame + i] = 0;
        }
      };

      const calculateStartTime = (
        phrase: Phrase,
        tempos: Tempo[],
        tpqn: number,
      ) => {
        return tickToSecond(
          phrase.notes[0].position - phrase.firstRestDuration,
          tempos,
          tpqn,
        );
      };

      const synthesize = async (singer: Singer, query: FrameAudioQuery) => {
        if (!getters.IS_ENGINE_READY(singer.engineId)) {
          throw new Error("Engine not ready.");
        }

        try {
          const instance = await actions.INSTANTIATE_ENGINE_CONNECTOR({
            engineId: singer.engineId,
          });
          return await instance.invoke("frameSynthesisFrameSynthesisPost")({
            frameAudioQuery: query,
            speaker: singer.styleId,
          });
        } catch (error) {
          const phonemes = query.phonemes
            .map((value) => value.phoneme)
            .join(" ");
          logger.error(
            `Failed to synthesis. Phonemes are "${phonemes}".`,
            error,
          );
          throw error;
        }
      };

      // NOTE: 型推論でawaitの前か後かが考慮されないので、関数を介して取得する（型がbooleanになるようにする）
      const startRenderingRequested = () => state.startRenderingRequested;
      const stopRenderingRequested = () => state.stopRenderingRequested;

      /**
       * フレーズが持つシーケンスのIDを取得する。
       * @param phraseKey フレーズのキー
       * @returns シーケンスID
       */
      const getPhraseSequenceId = (phraseKey: PhraseSourceHash) => {
        return getOrThrow(state.phrases, phraseKey).sequenceId;
      };

      const render = async () => {
        if (!audioContext) {
          throw new Error("audioContext is undefined.");
        }
        const audioContextRef = audioContext;

        // レンダリング中に変更される可能性のあるデータをコピーする
        const tracks = cloneWithUnwrapProxy(state.tracks);

        const overlappingNoteIdsMap = new Map(
          [...tracks.keys()].map((trackId) => [
            trackId,
            getters.OVERLAPPING_NOTE_IDS(trackId),
          ]),
        );

        const singerAndFrameRates = new Map(
          [...tracks].map(([trackId, track]) => [
            trackId,
            track.singer
              ? {
                  singer: track.singer,
                  frameRate:
                    state.engineManifests[track.singer.engineId].frameRate,
                }
              : undefined,
          ]),
        );
        const tpqn = state.tpqn;
        const tempos = state.tempos.map((value) => ({ ...value }));
        const editFrameRate = state.editFrameRate;

        const firstRestMinDurationSeconds = 0.12;
        const lastRestDurationSeconds = 0.5;
        const fadeOutDurationSeconds = 0.15;

        // フレーズを更新する

        const foundPhrases = new Map<PhraseSourceHash, Phrase>();
        for (const [trackId, track] of tracks) {
          if (!track.singer) {
            continue;
          }

          // 重なっているノートを削除する
          const overlappingNoteIds = getOrThrow(overlappingNoteIdsMap, trackId);
          const notes = track.notes.filter(
            (value) => !overlappingNoteIds.has(value.id),
          );
          const phrases = await searchPhrases(
            notes,
            tempos,
            tpqn,
            firstRestMinDurationSeconds,
            trackId,
          );
          for (const [phraseHash, phrase] of phrases) {
            foundPhrases.set(phraseHash, phrase);
          }
        }

        const phrases = new Map<PhraseSourceHash, Phrase>();
        const disappearedPhraseKeys = new Set<PhraseSourceHash>();

        for (const phraseKey of state.phrases.keys()) {
          if (!foundPhrases.has(phraseKey)) {
            // 無くなったフレーズの場合
            disappearedPhraseKeys.add(phraseKey);
          }
        }
        for (const [phraseKey, foundPhrase] of foundPhrases) {
          const existingPhrase = state.phrases.get(phraseKey);
          if (!existingPhrase) {
            // 新しいフレーズの場合
            phrases.set(phraseKey, foundPhrase);
            continue;
          }

          const track = getOrThrow(tracks, existingPhrase.trackId);

          const singerAndFrameRate = getOrThrow(
            singerAndFrameRates,
            existingPhrase.trackId,
          );

          // すでに存在するフレーズの場合
          // 再レンダリングする必要があるかどうかをチェックする
          // シンガーが未設定の場合、とりあえず常に再レンダリングする
          // 音声合成を行う必要がある場合、singingVoiceKeyをundefinedにする
          // 歌い方の推論も行う必要がある場合、singingGuideKeyとsingingVoiceKeyをundefinedにする
          // TODO: リファクタリングする
          const phrase = { ...existingPhrase };
          if (!singerAndFrameRate || phrase.state === "COULD_NOT_RENDER") {
            if (phrase.singingGuideKey != undefined) {
              phrase.singingGuideKey = undefined;
            }
            if (phrase.singingVoiceKey != undefined) {
              phrase.singingVoiceKey = undefined;
            }
          } else if (phrase.singingGuideKey != undefined) {
            const calculatedHash = await calculateSingingGuideSourceHash({
              engineId: singerAndFrameRate.singer.engineId,
              tpqn,
              tempos,
              firstRestDuration: phrase.firstRestDuration,
              lastRestDurationSeconds,
              notes: phrase.notes,
              keyRangeAdjustment: track.keyRangeAdjustment,
              volumeRangeAdjustment: track.volumeRangeAdjustment,
              frameRate: singerAndFrameRate.frameRate,
            });
            const hash = phrase.singingGuideKey;
            if (hash !== calculatedHash) {
              phrase.singingGuideKey = undefined;
              if (phrase.singingVoiceKey != undefined) {
                phrase.singingVoiceKey = undefined;
              }
            } else if (phrase.singingVoiceKey != undefined) {
              let singingGuide = getOrThrow(
                state.singingGuides,
                phrase.singingGuideKey,
              );

              // 歌い方をコピーして、ピッチ編集を適用する
              singingGuide = structuredClone(toRaw(singingGuide));
              applyPitchEdit(singingGuide, track.pitchEditData, editFrameRate);

              const calculatedHash = await calculateSingingVoiceSourceHash({
                singer: singerAndFrameRate.singer,
                frameAudioQuery: singingGuide.query,
              });
              const hash = phrase.singingVoiceKey;
              if (hash !== calculatedHash) {
                phrase.singingVoiceKey = undefined;
              }
            }
          }

          phrases.set(phraseKey, phrase);
        }

        // フレーズのstateを更新する
        for (const phrase of phrases.values()) {
          if (
            phrase.singingGuideKey == undefined ||
            phrase.singingVoiceKey == undefined
          ) {
            phrase.state = "WAITING_TO_BE_RENDERED";
          }
        }

        // 無くなったフレーズのシーケンスを削除する
        for (const phraseKey of disappearedPhraseKeys) {
          const phraseSequenceId = getPhraseSequenceId(phraseKey);
          if (phraseSequenceId != undefined) {
            deleteSequence(phraseSequenceId);
            mutations.SET_SEQUENCE_ID_TO_PHRASE({
              phraseKey,
              sequenceId: undefined,
            });
          }
        }

        // 使われていない歌い方と歌声を削除する
        const singingGuideKeysInUse = new Set(
          [...phrases.values()]
            .map((value) => value.singingGuideKey)
            .filter((value) => value != undefined),
        );
        const singingVoiceKeysInUse = new Set(
          [...phrases.values()]
            .map((value) => value.singingVoiceKey)
            .filter((value) => value != undefined),
        );
        const existingSingingGuideKeys = new Set(state.singingGuides.keys());
        const existingSingingVoiceKeys = new Set(singingVoices.keys());
        const singingGuideKeysToDelete = existingSingingGuideKeys.difference(
          singingGuideKeysInUse,
        );
        const singingVoiceKeysToDelete = existingSingingVoiceKeys.difference(
          singingVoiceKeysInUse,
        );
        for (const singingGuideKey of singingGuideKeysToDelete) {
          mutations.DELETE_SINGING_GUIDE({ singingGuideKey });
        }
        for (const singingVoiceKey of singingVoiceKeysToDelete) {
          singingVoices.delete(singingVoiceKey);
        }

        mutations.SET_PHRASES({ phrases });

        logger.info("Phrases updated.");

        // 各フレーズのレンダリングを行う

        const phrasesToBeRendered = new Map(
          [...state.phrases.entries()].filter(([, phrase]) => {
            return phrase.state === "WAITING_TO_BE_RENDERED";
          }),
        );
        for (const [phraseKey, phrase] of phrasesToBeRendered) {
          // シーケンスが存在する場合は、シーケンスを削除する
          // TODO: ピッチを編集したときは行わないようにする

          const phraseSequenceId = getPhraseSequenceId(phraseKey);
          if (phraseSequenceId != undefined) {
            deleteSequence(phraseSequenceId);
            mutations.SET_SEQUENCE_ID_TO_PHRASE({
              phraseKey,
              sequenceId: undefined,
            });
          }

          // ノートシーケンスを作成して登録し、プレビュー音が鳴るようにする

          const noteEvents = generateNoteEvents(phrase.notes, tempos, tpqn);
          const polySynth = new PolySynth(audioContextRef);
          const sequenceId = SequenceId(uuid4());
          registerSequence(sequenceId, {
            type: "note",
            instrument: polySynth,
            noteEvents,
            trackId: phrase.trackId,
          });
          mutations.SET_SEQUENCE_ID_TO_PHRASE({ phraseKey, sequenceId });
        }
        while (phrasesToBeRendered.size > 0) {
          if (startRenderingRequested() || stopRenderingRequested()) {
            return;
          }
          const [phraseKey, phrase] = selectPriorPhrase(
            phrasesToBeRendered,
            playheadPosition.value,
          );
          phrasesToBeRendered.delete(phraseKey);

          const track = getOrThrow(tracks, phrase.trackId);

          const singerAndFrameRate = getOrThrow(
            singerAndFrameRates,
            phrase.trackId,
          );

          // シンガーが未設定の場合は、歌い方の生成や音声合成は行わない

          if (!singerAndFrameRate) {
            mutations.SET_STATE_TO_PHRASE({
              phraseKey,
              phraseState: "PLAYABLE",
            });
            continue;
          }

          mutations.SET_STATE_TO_PHRASE({
            phraseKey,
            phraseState: "NOW_RENDERING",
          });

          try {
            // リクエスト（クエリ生成と音量生成）用のノーツを作る
            const notesForRequestToEngine = createNotesForRequestToEngine(
              phrase.firstRestDuration,
              lastRestDurationSeconds,
              phrase.notes,
              tempos,
              tpqn,
              singerAndFrameRate.frameRate,
            );

            // リクエスト用のノーツのキーのシフトを行う
            shiftKeyOfNotes(notesForRequestToEngine, -track.keyRangeAdjustment);

            // 歌い方が存在する場合、歌い方を取得する
            // 歌い方が存在しない場合、キャッシュがあれば取得し、なければ歌い方を生成する

            let singingGuide: SingingGuide | undefined;
            if (phrase.singingGuideKey != undefined) {
              singingGuide = getOrThrow(
                state.singingGuides,
                phrase.singingGuideKey,
              );
            } else {
              const singingGuideSourceHash =
                await calculateSingingGuideSourceHash({
                  engineId: singerAndFrameRate.singer.engineId,
                  tpqn,
                  tempos,
                  firstRestDuration: phrase.firstRestDuration,
                  lastRestDurationSeconds,
                  notes: phrase.notes,
                  keyRangeAdjustment: track.keyRangeAdjustment,
                  volumeRangeAdjustment: track.volumeRangeAdjustment,
                  frameRate: singerAndFrameRate.frameRate,
                });

              const singingGuideKey = singingGuideSourceHash;
              const cachedSingingGuide = singingGuideCache.get(singingGuideKey);
              if (cachedSingingGuide) {
                singingGuide = cachedSingingGuide;

                logger.info(`Loaded singing guide from cache.`);
              } else {
                // クエリを生成する
                const query = await fetchQuery(
                  singerAndFrameRate.singer.engineId,
                  notesForRequestToEngine,
                );

                const phonemes = getPhonemes(query);
                logger.info(`Fetched frame audio query. phonemes: ${phonemes}`);

                // ピッチのシフトを行う
                shiftGuidePitch(query, track.keyRangeAdjustment);

                // フレーズの開始時刻を計算する
                const startTime = calculateStartTime(phrase, tempos, tpqn);

                singingGuide = {
                  query,
                  frameRate: singerAndFrameRate.frameRate,
                  startTime,
                };

                singingGuideCache.set(singingGuideKey, singingGuide);
              }
              mutations.SET_SINGING_GUIDE({ singingGuideKey, singingGuide });
              mutations.SET_SINGING_GUIDE_KEY_TO_PHRASE({
                phraseKey,
                singingGuideKey,
              });
            }

            // ピッチ編集を適用する前に、歌い方をコピーする
            singingGuide = structuredClone(toRaw(singingGuide));

            // ピッチ編集を適用する
            applyPitchEdit(singingGuide, track.pitchEditData, editFrameRate);

            // 歌声のキャッシュがあれば取得し、なければ音声合成を行う

            let singingVoice: SingingVoice | undefined;

            const singingVoiceSourceHash =
              await calculateSingingVoiceSourceHash({
                singer: singerAndFrameRate.singer,
                frameAudioQuery: singingGuide.query,
              });

            const singingVoiceKey = singingVoiceSourceHash;
            const cachedSingingVoice = singingVoiceCache.get(singingVoiceKey);
            if (cachedSingingVoice) {
              singingVoice = cachedSingingVoice;

              logger.info(`Loaded singing voice from cache.`);
            } else {
              // 音量生成用のクエリを作る
              // ピッチ編集を適用したクエリをコピーし、
              // f0をもう一度シフトして、元の（クエリ生成時の）高さに戻す
              const queryForVolumeGeneration = structuredClone(
                singingGuide.query,
              );
              shiftGuidePitch(
                queryForVolumeGeneration,
                -track.keyRangeAdjustment,
              );

              // 音量を生成して、生成した音量を歌い方のクエリにセットする
              // 音量値はAPIを叩く毎に変わるので、calc hashしたあとに音量を取得している
              const volumes = await actions.FETCH_SING_FRAME_VOLUME({
                notes: notesForRequestToEngine,
                frameAudioQuery: queryForVolumeGeneration,
                styleId: singingTeacherStyleId,
                engineId: singerAndFrameRate.singer.engineId,
              });
              singingGuide.query.volume = volumes;

              // 音量のシフトを行う
              shiftGuideVolume(singingGuide.query, track.volumeRangeAdjustment);

              // 末尾のpauの区間の音量を0にする
              muteLastPauSection(
                singingGuide.query,
                singerAndFrameRate.frameRate,
                fadeOutDurationSeconds,
              );

              // 音声合成を行う
              const blob = await synthesize(
                singerAndFrameRate.singer,
                singingGuide.query,
              );

              logger.info(`Synthesized.`);

              singingVoice = { blob };
              singingVoiceCache.set(singingVoiceKey, singingVoice);
            }
            singingVoices.set(singingVoiceKey, singingVoice);
            mutations.SET_SINGING_VOICE_KEY_TO_PHRASE({
              phraseKey,
              singingVoiceKey,
            });

            // シーケンスが存在する場合、シーケンスを削除する

            const phraseSequenceId = getPhraseSequenceId(phraseKey);
            if (phraseSequenceId != undefined) {
              deleteSequence(phraseSequenceId);
              mutations.SET_SEQUENCE_ID_TO_PHRASE({
                phraseKey,
                sequenceId: undefined,
              });
            }

            // オーディオシーケンスを作成して登録する

            const audioEvents = await generateAudioEvents(
              audioContextRef,
              singingGuide.startTime,
              singingVoice.blob,
            );
            const audioPlayer = new AudioPlayer(audioContext);
            const sequenceId = SequenceId(uuid4());
            registerSequence(sequenceId, {
              type: "audio",
              audioPlayer,
              audioEvents,
              trackId: phrase.trackId,
            });
            mutations.SET_SEQUENCE_ID_TO_PHRASE({ phraseKey, sequenceId });

            mutations.SET_STATE_TO_PHRASE({
              phraseKey,
              phraseState: "PLAYABLE",
            });
          } catch (error) {
            mutations.SET_STATE_TO_PHRASE({
              phraseKey,
              phraseState: "COULD_NOT_RENDER",
            });
            // とりあえずエラーはロギングしてcontinueする
            // NOTE: ほとんどは歌詞のエラー
            // FIXME: 歌詞以外のエラーの場合はthrowして、エラーダイアログを表示するようにする
            logger.error("An error occurred while rendering a phrase.", error);
            continue;
          }
        }
      };

      mutations.SET_START_RENDERING_REQUESTED({
        startRenderingRequested: true,
      });
      if (state.nowRendering) {
        return;
      }

      mutations.SET_NOW_RENDERING({ nowRendering: true });
      try {
        while (startRenderingRequested()) {
          mutations.SET_START_RENDERING_REQUESTED({
            startRenderingRequested: false,
          });
          await render();
          if (stopRenderingRequested()) {
            break;
          }
        }
      } catch (error) {
        logger.error("render error", error);
        throw error;
      } finally {
        mutations.SET_STOP_RENDERING_REQUESTED({
          stopRenderingRequested: false,
        });
        mutations.SET_NOW_RENDERING({ nowRendering: false });
      }
    },
  },

  /**
   * レンダリング停止をリクエストし、停止するまで待機する。
   */
  STOP_RENDERING: {
    action: createUILockAction(async ({ state, mutations }) => {
      if (state.nowRendering) {
        logger.info("Waiting for rendering to stop...");
        mutations.SET_STOP_RENDERING_REQUESTED({
          stopRenderingRequested: true,
        });
        await createPromiseThatResolvesWhen(() => !state.nowRendering);
        logger.info("Rendering stopped.");
      }
    }),
  },

  FETCH_SING_FRAME_VOLUME: {
    async action(
      { actions },
      {
        notes,
        frameAudioQuery,
        engineId,
        styleId,
      }: {
        notes: NoteForRequestToEngine[];
        frameAudioQuery: FrameAudioQuery;
        engineId: EngineId;
        styleId: StyleId;
      },
    ) {
      const instance = await actions.INSTANTIATE_ENGINE_CONNECTOR({
        engineId,
      });
      return await instance.invoke("singFrameVolumeSingFrameVolumePost")({
        bodySingFrameVolumeSingFrameVolumePost: {
          score: {
            notes,
          },
          frameAudioQuery,
        },
        speaker: styleId,
      });
    },
  },
  SET_NOW_AUDIO_EXPORTING: {
    mutation(state, { nowAudioExporting }) {
      state.nowAudioExporting = nowAudioExporting;
    },
  },

  SET_CANCELLATION_OF_AUDIO_EXPORT_REQUESTED: {
    mutation(state, { cancellationOfAudioExportRequested }) {
      state.cancellationOfAudioExportRequested =
        cancellationOfAudioExportRequested;
    },
  },

  EXPORT_WAVE_FILE: {
    action: createUILockAction(
      async ({ state, mutations, getters, actions }, { filePath }) => {
        const exportWaveFile = async (): Promise<SaveResultObject> => {
          const fileName = generateDefaultSongFileName(
            getters.PROJECT_NAME,
            getters.SELECTED_TRACK,
            getters.CHARACTER_INFO,
          );
          const numberOfChannels = 2;
          const sampleRate = 48000; // TODO: 設定できるようにする
          const withLimiter = true; // TODO: 設定できるようにする

          const renderDuration = getters.CALC_RENDER_DURATION;

          if (state.nowPlaying) {
            await actions.SING_STOP_AUDIO();
          }

          if (state.savingSetting.fixedExportEnabled) {
            filePath = path.join(state.savingSetting.fixedExportDir, fileName);
          } else {
            filePath ??= await window.backend.showAudioSaveDialog({
              title: "音声を保存",
              defaultPath: fileName,
            });
          }
          if (!filePath) {
            return { result: "CANCELED", path: "" };
          }

          if (state.savingSetting.avoidOverwrite) {
            let tail = 1;
            const name = filePath.slice(0, filePath.length - 4);
            while (await window.backend.checkFileExists(filePath)) {
              filePath = name + "[" + tail.toString() + "]" + ".wav";
              tail += 1;
            }
          }

          if (state.nowRendering) {
            await createPromiseThatResolvesWhen(() => {
              return (
                !state.nowRendering || state.cancellationOfAudioExportRequested
              );
            });
            if (state.cancellationOfAudioExportRequested) {
              return { result: "CANCELED", path: "" };
            }
          }

          const audioBuffer = await offlineRenderTracks(
            numberOfChannels,
            sampleRate,
            renderDuration,
            withLimiter,
            state.experimentalSetting.enableMultiTrack,
            state.tracks,
            state.phrases,
            state.singingGuides,
            singingVoiceCache,
          );

          const waveFileData = convertToWavFileData(audioBuffer);

          try {
            await window.backend
              .writeFile({
                filePath,
                buffer: waveFileData,
              })
              .then(getValueOrThrow);
          } catch (e) {
            logger.error("Failed to exoprt the wav file.", e);
            if (e instanceof ResultError) {
              return {
                result: "WRITE_ERROR",
                path: filePath,
                errorMessage: generateWriteErrorMessage(
                  e as ResultError<string>,
                ),
              };
            }
            return {
              result: "UNKNOWN_ERROR",
              path: filePath,
              errorMessage:
                (e instanceof Error ? e.message : String(e)) ||
                "不明なエラーが発生しました。",
            };
          }

          return { result: "SUCCESS", path: filePath };
        };

        mutations.SET_NOW_AUDIO_EXPORTING({ nowAudioExporting: true });
        return exportWaveFile().finally(() => {
          mutations.SET_CANCELLATION_OF_AUDIO_EXPORT_REQUESTED({
            cancellationOfAudioExportRequested: false,
          });
          mutations.SET_NOW_AUDIO_EXPORTING({ nowAudioExporting: false });
        });
      },
    ),
  },

  CANCEL_AUDIO_EXPORT: {
    async action({ state, mutations }) {
      if (!state.nowAudioExporting) {
        logger.warn("CANCEL_AUDIO_EXPORT on !nowAudioExporting");
        return;
      }
      mutations.SET_CANCELLATION_OF_AUDIO_EXPORT_REQUESTED({
        cancellationOfAudioExportRequested: true,
      });
    },
  },

  COPY_NOTES_TO_CLIPBOARD: {
    async action({ getters }) {
      const selectedTrack = getters.SELECTED_TRACK;
      const noteIds = getters.SELECTED_NOTE_IDS;
      // ノートが選択されていない場合は何もしない
      if (noteIds.size === 0) {
        return;
      }
      // 選択されたノートのみをコピーする
      const selectedNotes = selectedTrack.notes
        .filter((note: Note) => noteIds.has(note.id))
        .map((note: Note) => {
          // idのみコピーしない
          const { id, ...noteWithoutId } = note;
          return noteWithoutId;
        });
      // ノートをJSONにシリアライズしてクリップボードにコピーする
      const serializedNotes = JSON.stringify(selectedNotes);
      // クリップボードにテキストとしてコピーする
      // NOTE: Electronのclipboardも使用する必要ある？
      await navigator.clipboard.writeText(serializedNotes);
      logger.info("Copied to clipboard.", serializedNotes);
    },
  },

  COMMAND_CUT_NOTES_TO_CLIPBOARD: {
    async action({ actions }) {
      await actions.COPY_NOTES_TO_CLIPBOARD();
      await actions.COMMAND_REMOVE_SELECTED_NOTES();
    },
  },

  COMMAND_PASTE_NOTES_FROM_CLIPBOARD: {
    async action({ mutations, state, getters, actions }) {
      // クリップボードからテキストを読み込む
      let clipboardText;
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch (error) {
        throw new Error("Failed to read the clipboard text.", {
          cause: error,
        });
      }

      // クリップボードのテキストをJSONとしてパースする(失敗した場合はエラーを返す)
      let notes;
      try {
        notes = noteSchema
          .omit({ id: true })
          .array()
          .parse(JSON.parse(clipboardText));
      } catch (error) {
        throw new Error("Failed to parse the clipboard text as JSON.", {
          cause: error,
        });
      }

      // パースしたJSONのノートの位置を現在の再生位置に合わせてクオンタイズして貼り付ける
      const currentPlayheadPosition = getters.GET_PLAYHEAD_POSITION();
      const firstNotePosition = notes[0].position;
      // TODO: クオンタイズの処理を共通化する
      const snapType = state.sequencerSnapType;
      const tpqn = state.tpqn;
      const snapTicks = getNoteDuration(snapType, tpqn);
      const notesToPaste: Note[] = notes.map((note) => {
        // 新しい位置を現在の再生位置に合わせて計算する
        const pasteOriginPos =
          Number(note.position) - firstNotePosition + currentPlayheadPosition;
        // クオンタイズ
        const quantizedPastePos =
          Math.round(pasteOriginPos / snapTicks) * snapTicks;
        return {
          id: NoteId(uuid4()),
          position: quantizedPastePos,
          duration: Number(note.duration),
          noteNumber: Number(note.noteNumber),
          lyric: String(note.lyric),
        };
      });
      const pastedNoteIds = notesToPaste.map((note) => note.id);
      // ノートを追加してレンダリングする
      mutations.COMMAND_ADD_NOTES({
        notes: notesToPaste,
        trackId: getters.SELECTED_TRACK_ID,
      });

      void actions.RENDER();
      // 貼り付けたノートを選択する
      mutations.DESELECT_ALL_NOTES();
      mutations.SELECT_NOTES({ noteIds: pastedNoteIds });
    },
  },

  COMMAND_QUANTIZE_SELECTED_NOTES: {
    action({ state, mutations, getters, actions }) {
      const selectedTrack = getters.SELECTED_TRACK;
      const selectedNotes = selectedTrack.notes.filter((note: Note) => {
        return getters.SELECTED_NOTE_IDS.has(note.id);
      });
      // TODO: クオンタイズの処理を共通化する
      const snapType = state.sequencerSnapType;
      const tpqn = state.tpqn;
      const snapTicks = getNoteDuration(snapType, tpqn);
      const quantizedNotes = selectedNotes.map((note: Note) => {
        const quantizedPosition =
          Math.round(note.position / snapTicks) * snapTicks;
        return { ...note, position: quantizedPosition };
      });
      mutations.COMMAND_UPDATE_NOTES({
        notes: quantizedNotes,
        trackId: getters.SELECTED_TRACK_ID,
      });

      void actions.RENDER();
    },
  },

  SET_SONG_SIDEBAR_OPEN: {
    mutation(state, { isSongSidebarOpen }) {
      state.isSongSidebarOpen = isSongSidebarOpen;
    },
    action({ mutations }, { isSongSidebarOpen }) {
      mutations.SET_SONG_SIDEBAR_OPEN({ isSongSidebarOpen });
    },
  },

  SET_TRACK_NAME: {
    mutation(state, { trackId, name }) {
      const track = getOrThrow(state.tracks, trackId);
      track.name = name;
    },
    action({ mutations }, { trackId, name }) {
      mutations.SET_TRACK_NAME({ trackId, name });
    },
  },

  SET_TRACK_MUTE: {
    mutation(state, { trackId, mute }) {
      const track = getOrThrow(state.tracks, trackId);
      track.mute = mute;
    },
    action({ mutations, actions }, { trackId, mute }) {
      mutations.SET_TRACK_MUTE({ trackId, mute });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
    },
  },

  SET_TRACK_SOLO: {
    mutation(state, { trackId, solo }) {
      const track = getOrThrow(state.tracks, trackId);
      track.solo = solo;
    },
    action({ mutations, actions }, { trackId, solo }) {
      mutations.SET_TRACK_SOLO({ trackId, solo });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
    },
  },

  SET_TRACK_GAIN: {
    mutation(state, { trackId, gain }) {
      const track = getOrThrow(state.tracks, trackId);
      track.gain = gain;
    },
    action({ mutations, actions }, { trackId, gain }) {
      mutations.SET_TRACK_GAIN({ trackId, gain });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
    },
  },

  SET_TRACK_PAN: {
    mutation(state, { trackId, pan }) {
      const track = getOrThrow(state.tracks, trackId);
      track.pan = pan;
    },
    action({ mutations, actions }, { trackId, pan }) {
      mutations.SET_TRACK_PAN({ trackId, pan });

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
    },
  },

  SET_SELECTED_TRACK: {
    mutation(state, { trackId }) {
      state._selectedTrackId = trackId;
    },
    action({ mutations }, { trackId }) {
      mutations.SET_SELECTED_TRACK({ trackId });
    },
  },

  REORDER_TRACKS: {
    mutation(state, { trackOrder }) {
      state.trackOrder = trackOrder;
    },
    action({ mutations }, { trackOrder }) {
      mutations.REORDER_TRACKS({ trackOrder });
    },
  },

  UNSOLO_ALL_TRACKS: {
    mutation(state) {
      for (const track of state.tracks.values()) {
        track.solo = false;
      }
    },
    action({ mutations, actions }) {
      mutations.UNSOLO_ALL_TRACKS();

      void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      void actions.RENDER();
    },
  },

  CALC_RENDER_DURATION: {
    getter(state) {
      const notes = [...state.tracks.values()].flatMap((track) => track.notes);
      if (notes.length === 0) {
        return 1;
      }
      notes.sort((a, b) => a.position + a.duration - (b.position + b.duration));
      const lastNote = notes[notes.length - 1];
      const lastNoteEndPosition = lastNote.position + lastNote.duration;
      const lastNoteEndTime = tickToSecond(
        lastNoteEndPosition,
        state.tempos,
        state.tpqn,
      );
      return Math.max(1, lastNoteEndTime + 1);
    },
  },
});

export const singingCommandStoreState: SingingCommandStoreState = {};

export const singingCommandStore = transformCommandStore(
  createPartialStore<SingingCommandStoreTypes>({
    COMMAND_SET_SINGER: {
      mutation(draft, { singer, withRelated, trackId }) {
        singingStore.mutations.SET_SINGER(draft, {
          singer,
          withRelated,
          trackId,
        });
      },
      async action({ actions, mutations }, { singer, withRelated, trackId }) {
        void actions.SETUP_SINGER({ singer });
        mutations.COMMAND_SET_SINGER({ singer, withRelated, trackId });

        void actions.RENDER();
      },
    },
    COMMAND_SET_KEY_RANGE_ADJUSTMENT: {
      mutation(draft, { keyRangeAdjustment, trackId }) {
        singingStore.mutations.SET_KEY_RANGE_ADJUSTMENT(draft, {
          keyRangeAdjustment,
          trackId,
        });
      },
      async action({ actions, mutations }, { keyRangeAdjustment, trackId }) {
        if (!isValidKeyRangeAdjustment(keyRangeAdjustment)) {
          throw new Error("The keyRangeAdjustment is invalid.");
        }
        mutations.COMMAND_SET_KEY_RANGE_ADJUSTMENT({
          keyRangeAdjustment,
          trackId,
        });

        void actions.RENDER();
      },
    },
    COMMAND_SET_VOLUME_RANGE_ADJUSTMENT: {
      mutation(draft, { volumeRangeAdjustment, trackId }) {
        singingStore.mutations.SET_VOLUME_RANGE_ADJUSTMENT(draft, {
          volumeRangeAdjustment,
          trackId,
        });
      },
      async action({ actions, mutations }, { volumeRangeAdjustment, trackId }) {
        if (!isValidVolumeRangeAdjustment(volumeRangeAdjustment)) {
          throw new Error("The volumeRangeAdjustment is invalid.");
        }
        mutations.COMMAND_SET_VOLUME_RANGE_ADJUSTMENT({
          volumeRangeAdjustment,
          trackId,
        });

        void actions.RENDER();
      },
    },
    COMMAND_SET_TEMPO: {
      mutation(draft, { tempo }) {
        singingStore.mutations.SET_TEMPO(draft, { tempo });
      },
      // テンポを設定する。既に同じ位置にテンポが存在する場合は置き換える。
      action(
        { state, getters, mutations, actions },
        { tempo }: { tempo: Tempo },
      ) {
        if (!transport) {
          throw new Error("transport is undefined.");
        }
        if (!isValidTempo(tempo)) {
          throw new Error("The tempo is invalid.");
        }
        if (state.nowPlaying) {
          playheadPosition.value = getters.SECOND_TO_TICK(transport.time);
        }
        tempo.bpm = round(tempo.bpm, 2);
        mutations.COMMAND_SET_TEMPO({ tempo });
        transport.time = getters.TICK_TO_SECOND(playheadPosition.value);

        void actions.RENDER();
      },
    },
    COMMAND_REMOVE_TEMPO: {
      mutation(draft, { position }) {
        singingStore.mutations.REMOVE_TEMPO(draft, { position });
      },
      // テンポを削除する。先頭のテンポの場合はデフォルトのテンポに置き換える。
      action(
        { state, getters, mutations, actions },
        { position }: { position: number },
      ) {
        const exists = state.tempos.some((value) => {
          return value.position === position;
        });
        if (!exists) {
          throw new Error("The tempo does not exist.");
        }
        if (!transport) {
          throw new Error("transport is undefined.");
        }
        if (state.nowPlaying) {
          playheadPosition.value = getters.SECOND_TO_TICK(transport.time);
        }
        mutations.COMMAND_REMOVE_TEMPO({ position });
        transport.time = getters.TICK_TO_SECOND(playheadPosition.value);

        void actions.RENDER();
      },
    },
    COMMAND_SET_TIME_SIGNATURE: {
      mutation(draft, { timeSignature }) {
        singingStore.mutations.SET_TIME_SIGNATURE(draft, { timeSignature });
      },
      // 拍子を設定する。既に同じ位置に拍子が存在する場合は置き換える。
      action(
        { mutations },
        { timeSignature }: { timeSignature: TimeSignature },
      ) {
        if (!isValidTimeSignature(timeSignature)) {
          throw new Error("The time signature is invalid.");
        }
        mutations.COMMAND_SET_TIME_SIGNATURE({ timeSignature });
      },
    },
    COMMAND_REMOVE_TIME_SIGNATURE: {
      mutation(draft, { measureNumber }) {
        singingStore.mutations.REMOVE_TIME_SIGNATURE(draft, { measureNumber });
      },
      // 拍子を削除する。先頭の拍子の場合はデフォルトの拍子に置き換える。
      action(
        { state, mutations },
        { measureNumber }: { measureNumber: number },
      ) {
        const exists = state.timeSignatures.some((value) => {
          return value.measureNumber === measureNumber;
        });
        if (!exists) {
          throw new Error("The time signature does not exist.");
        }
        mutations.COMMAND_REMOVE_TIME_SIGNATURE({ measureNumber });
      },
    },
    COMMAND_ADD_NOTES: {
      mutation(draft, { notes, trackId }) {
        singingStore.mutations.ADD_NOTES(draft, { notes, trackId });
      },
      action({ getters, mutations, actions }, { notes, trackId }) {
        const existingNoteIds = getters.ALL_NOTE_IDS;
        const isValidNotes = notes.every((value) => {
          return !existingNoteIds.has(value.id) && isValidNote(value);
        });
        if (!isValidNotes) {
          throw new Error("The notes are invalid.");
        }
        mutations.COMMAND_ADD_NOTES({ notes, trackId });

        void actions.RENDER();
      },
    },
    COMMAND_UPDATE_NOTES: {
      mutation(draft, { notes, trackId }) {
        singingStore.mutations.UPDATE_NOTES(draft, { notes, trackId });
      },
      action({ getters, mutations, actions }, { notes, trackId }) {
        const existingNoteIds = getters.ALL_NOTE_IDS;
        const isValidNotes = notes.every((value) => {
          return existingNoteIds.has(value.id) && isValidNote(value);
        });
        if (!isValidNotes) {
          throw new Error("The notes are invalid.");
        }
        mutations.COMMAND_UPDATE_NOTES({ notes, trackId });

        void actions.RENDER();
      },
    },
    COMMAND_REMOVE_NOTES: {
      mutation(draft, { noteIds, trackId }) {
        singingStore.mutations.REMOVE_NOTES(draft, { noteIds, trackId });
      },
      action({ getters, mutations, actions }, { noteIds, trackId }) {
        const existingNoteIds = getters.ALL_NOTE_IDS;
        const isValidNoteIds = noteIds.every((value) => {
          return existingNoteIds.has(value);
        });
        if (!isValidNoteIds) {
          throw new Error("The note ids are invalid.");
        }
        mutations.COMMAND_REMOVE_NOTES({ noteIds, trackId });

        void actions.RENDER();
      },
    },
    COMMAND_REMOVE_SELECTED_NOTES: {
      action({ mutations, getters, actions }) {
        mutations.COMMAND_REMOVE_NOTES({
          noteIds: [...getters.SELECTED_NOTE_IDS],
          trackId: getters.SELECTED_TRACK_ID,
        });

        void actions.RENDER();
      },
    },
    COMMAND_SET_PITCH_EDIT_DATA: {
      mutation(draft, { pitchArray, startFrame, trackId }) {
        singingStore.mutations.SET_PITCH_EDIT_DATA(draft, {
          pitchArray,
          startFrame,
          trackId,
        });
      },
      action({ mutations, actions }, { pitchArray, startFrame, trackId }) {
        if (startFrame < 0) {
          throw new Error("startFrame must be greater than or equal to 0.");
        }
        if (!isValidPitchEditData(pitchArray)) {
          throw new Error("The pitch edit data is invalid.");
        }
        mutations.COMMAND_SET_PITCH_EDIT_DATA({
          pitchArray,
          startFrame,
          trackId,
        });

        void actions.RENDER();
      },
    },
    COMMAND_ERASE_PITCH_EDIT_DATA: {
      mutation(draft, { startFrame, frameLength, trackId }) {
        singingStore.mutations.ERASE_PITCH_EDIT_DATA(draft, {
          startFrame,
          frameLength,
          trackId,
        });
      },
      action({ mutations, actions }, { startFrame, frameLength, trackId }) {
        if (startFrame < 0) {
          throw new Error("startFrame must be greater than or equal to 0.");
        }
        if (frameLength < 1) {
          throw new Error("frameLength must be at least 1.");
        }
        mutations.COMMAND_ERASE_PITCH_EDIT_DATA({
          startFrame,
          frameLength,
          trackId,
        });

        void actions.RENDER();
      },
    },

    COMMAND_INSERT_EMPTY_TRACK: {
      mutation(draft, { trackId, track, prevTrackId }) {
        singingStore.mutations.INSERT_TRACK(draft, {
          trackId,
          track,
          prevTrackId,
        });
      },
      /**
       * 空のトラックをprevTrackIdの後ろに挿入する。
       * prevTrackIdのトラックの情報を一部引き継ぐ。
       */
      async action({ state, actions, mutations }, { prevTrackId }) {
        const { trackId, track } = await actions.CREATE_TRACK();
        const sourceTrack = getOrThrow(state.tracks, prevTrackId);
        track.singer = sourceTrack.singer;
        track.keyRangeAdjustment = sourceTrack.keyRangeAdjustment;
        track.volumeRangeAdjustment = sourceTrack.volumeRangeAdjustment;
        mutations.COMMAND_INSERT_EMPTY_TRACK({
          trackId,
          track: cloneWithUnwrapProxy(track),
          prevTrackId,
        });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
        void actions.RENDER();
      },
    },

    COMMAND_DELETE_TRACK: {
      mutation(draft, { trackId }) {
        singingStore.mutations.DELETE_TRACK(draft, { trackId });
      },
      action({ mutations, actions }, { trackId }) {
        mutations.COMMAND_DELETE_TRACK({ trackId });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
        void actions.RENDER();
      },
    },

    COMMAND_SET_TRACK_NAME: {
      mutation(draft, { trackId, name }) {
        singingStore.mutations.SET_TRACK_NAME(draft, { trackId, name });
      },
      action({ mutations }, { trackId, name }) {
        mutations.COMMAND_SET_TRACK_NAME({ trackId, name });
      },
    },

    COMMAND_SET_TRACK_MUTE: {
      mutation(draft, { trackId, mute }) {
        singingStore.mutations.SET_TRACK_MUTE(draft, { trackId, mute });
      },
      action({ mutations, actions }, { trackId, mute }) {
        mutations.COMMAND_SET_TRACK_MUTE({ trackId, mute });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      },
    },

    COMMAND_SET_TRACK_SOLO: {
      mutation(draft, { trackId, solo }) {
        singingStore.mutations.SET_TRACK_SOLO(draft, { trackId, solo });
      },
      action({ mutations, actions }, { trackId, solo }) {
        mutations.COMMAND_SET_TRACK_SOLO({ trackId, solo });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      },
    },

    COMMAND_SET_TRACK_GAIN: {
      mutation(draft, { trackId, gain }) {
        singingStore.mutations.SET_TRACK_GAIN(draft, { trackId, gain });
      },
      action({ mutations, actions }, { trackId, gain }) {
        mutations.COMMAND_SET_TRACK_GAIN({ trackId, gain });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      },
    },

    COMMAND_SET_TRACK_PAN: {
      mutation(draft, { trackId, pan }) {
        singingStore.mutations.SET_TRACK_PAN(draft, { trackId, pan });
      },
      action({ mutations, actions }, { trackId, pan }) {
        mutations.COMMAND_SET_TRACK_PAN({ trackId, pan });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
      },
    },

    COMMAND_REORDER_TRACKS: {
      mutation(draft, { trackOrder }) {
        singingStore.mutations.REORDER_TRACKS(draft, { trackOrder });
      },
      action({ mutations }, { trackOrder }) {
        mutations.COMMAND_REORDER_TRACKS({ trackOrder });
      },
    },

    COMMAND_UNSOLO_ALL_TRACKS: {
      mutation(draft) {
        singingStore.mutations.UNSOLO_ALL_TRACKS(draft, undefined);
      },
      action({ mutations, actions }) {
        mutations.COMMAND_UNSOLO_ALL_TRACKS();

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
        void actions.RENDER();
      },
    },

    COMMAND_IMPORT_TRACKS: {
      mutation(draft, { tpqn, tempos, timeSignatures, tracks }) {
        singingStore.mutations.SET_TPQN(draft, { tpqn });
        singingStore.mutations.SET_TEMPOS(draft, { tempos });
        singingStore.mutations.SET_TIME_SIGNATURES(draft, { timeSignatures });
        for (const { track, trackId, overwrite, prevTrackId } of tracks) {
          if (overwrite) {
            singingStore.mutations.SET_TRACK(draft, { track, trackId });
          } else {
            singingStore.mutations.INSERT_TRACK(draft, {
              track,
              trackId,
              prevTrackId,
            });
          }
        }
      },
      /**
       * 複数のトラックを選択中のトラックの後ろに挿入し、テンポ情報などをインポートする。
       * 空のプロジェクトならトラックを上書きする。
       */
      async action(
        { state, mutations, getters, actions },
        { tpqn, tempos, timeSignatures, tracks },
      ) {
        const payload: ({ track: Track; trackId: TrackId } & (
          | { overwrite: true; prevTrackId?: undefined }
          | { overwrite?: false; prevTrackId: TrackId }
        ))[] = [];
        if (state.experimentalSetting.enableMultiTrack) {
          let prevTrackId = getters.SELECTED_TRACK_ID;
          for (const [i, track] of tracks.entries()) {
            if (!isValidTrack(track)) {
              throw new Error("The track is invalid.");
            }
            // 空のプロジェクトならトラックを上書きする
            if (i === 0 && isTracksEmpty([...state.tracks.values()])) {
              payload.push({
                track,
                trackId: prevTrackId,
                overwrite: true,
              });
            } else {
              const { trackId } = await actions.CREATE_TRACK();
              payload.push({ track, trackId, prevTrackId });
              prevTrackId = trackId;
            }
          }
        } else {
          // マルチトラックが無効な場合は最初のトラックのみをインポートする
          payload.push({
            track: tracks[0],
            trackId: getters.SELECTED_TRACK_ID,
            overwrite: true,
          });
        }

        mutations.COMMAND_IMPORT_TRACKS({
          tpqn,
          tempos,
          timeSignatures,
          tracks: payload,
        });

        void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
        void actions.RENDER();
      },
    },

    COMMAND_IMPORT_UTAFORMATIX_PROJECT: {
      action: createUILockAction(
        async ({ state, getters, actions }, { project, trackIndexes }) => {
          const { tempos, timeSignatures, tracks, tpqn } =
            ufProjectToVoicevox(project);

          if (tempos.length > 1) {
            logger.warn("Multiple tempos are not supported.");
          }
          if (timeSignatures.length > 1) {
            logger.warn("Multiple time signatures are not supported.");
          }

          tempos.splice(1, tempos.length - 1); // TODO: 複数テンポに対応したら削除
          timeSignatures.splice(1, timeSignatures.length - 1); // TODO: 複数拍子に対応したら削除

          if (tpqn !== state.tpqn) {
            throw new Error("TPQN does not match. Must be converted.");
          }

          const selectedTrack = getOrThrow(
            state.tracks,
            getters.SELECTED_TRACK_ID,
          );

          const filteredTracks = trackIndexes.map((trackIndex) => {
            const track = tracks[trackIndex];
            if (!track) {
              throw new Error("Track not found.");
            }
            return {
              ...toRaw(selectedTrack),
              notes: track.notes.map((note) => ({
                ...note,
                id: NoteId(uuid4()),
              })),
            };
          });

          await actions.COMMAND_IMPORT_TRACKS({
            tpqn,
            tempos,
            timeSignatures,
            tracks: filteredTracks,
          });

          void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
          void actions.RENDER();
        },
      ),
    },

    COMMAND_IMPORT_VOICEVOX_PROJECT: {
      action: createUILockAction(
        async ({ state, actions }, { project, trackIndexes }) => {
          const { tempos, timeSignatures, tracks, tpqn, trackOrder } =
            project.song;

          tempos.splice(1, tempos.length - 1); // TODO: 複数テンポに対応したら削除
          timeSignatures.splice(1, timeSignatures.length - 1); // TODO: 複数拍子に対応したら削除

          if (tpqn !== state.tpqn) {
            throw new Error("TPQN does not match. Must be converted.");
          }

          const filteredTracks = trackIndexes.map((trackIndex) => {
            const track = tracks[trackOrder[trackIndex]];
            if (!track) {
              throw new Error("Track not found.");
            }
            return {
              ...toRaw(track),
              notes: track.notes.map((note) => ({
                ...note,
                id: NoteId(uuid4()),
              })),
            };
          });

          await actions.COMMAND_IMPORT_TRACKS({
            tpqn,
            tempos,
            timeSignatures,
            tracks: filteredTracks,
          });

          void actions.SYNC_TRACKS_AND_TRACK_CHANNEL_STRIPS();
          void actions.RENDER();
        },
      ),
    },
  }),
  "song",
);
