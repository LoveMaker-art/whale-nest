#!/usr/bin/env python3
"""Inspect the limited two-voice ABC dialect used by YuE2 and SheetSage2.

Original, standard-library-only implementation. This is deliberately not a
general ABC parser or a replacement for SheetSage2's native score serializer.
All times are exact fractions of a quarter note. See references/abc-editing.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path


VOICES = ("Vocal", "Ins")
DURATIONS = {1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48}
QUALITIES = ("", "m", "dim", "aug", "7", "maj7", "m7", "dim7", "m7b5",
             "sus4", "sus2", "6", "m6", "7sus4", "m(maj7)")
PITCH_NAME = r"[A-G](?:bb|##|b|#)?"
CHORD = re.compile(PITCH_NAME + "(?:" + "|".join(re.escape(q) for q in QUALITIES)
                   + ")(?:/" + PITCH_NAME + ")?")
TOKEN = re.compile(
    r'"(?P<chord>[^"\n]*)"|\[K:(?P<key>[^\]\n]+)\]|'
    r"(?P<acc>\^\^|__|\^|_|=)?(?P<note>[A-Ga-gz])"
    r"(?P<oct>[,']*)(?P<duration>[0-9]*)(?P<tie>-?)"
)
NATURAL = dict(zip("CDEFGAB", (0, 2, 4, 5, 7, 9, 11)))
KEYS = {
    **dict(zip(("Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"), range(-7, 8))),
    **dict(zip(("Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"), range(-7, 8))),
}


class AbcError(ValueError):
    """Unsupported notation or a failed structural invariant."""


def fail(condition: bool, message: str) -> None:
    if condition:
        raise AbcError(message)


def key_accidentals(key: str) -> dict[str, int]:
    fail(key not in KEYS, f"Unsupported key {key!r}; use a standard major or minor K: field")
    count = KEYS[key]
    result = {letter: 0 for letter in NATURAL}
    for letter in ("FCGDAEB" if count > 0 else "BEADGCF")[:abs(count)]:
        result[letter] = 1 if count > 0 else -1
    return result


def meter_value(text: str) -> tuple[int, int]:
    match = re.fullmatch(r"([1-9][0-9]*)/([1-9][0-9]*)", text)
    fail(match is None, f"Unsupported meter {text!r}; write an explicit fraction")
    n, d = map(int, match.groups())
    fail(d > 1024 or d & (d - 1) != 0, f"Unsupported meter denominator {d}")
    return n, d


@dataclass
class Voice:
    meter: tuple[int, int]
    key: str
    time: Fraction = Fraction(0)
    notes: list = field(default_factory=list)
    bars: list = field(default_factory=list)
    chords: list = field(default_factory=list)
    keys: list = field(default_factory=list)
    pending: tuple | None = None


@dataclass
class Score:
    text: str
    unit: Fraction
    bpm: int
    voices: dict[str, Voice]
    music_lines: dict[int, str]


def parse_bar(body: str, voice: Voice, unit: Fraction, context: str) -> None:
    n, d = voice.meter
    length = Fraction(4 * n, d)
    start = voice.time
    offset = Fraction(0)
    local = {}  # Native exporters propagate accidentals by letter, across octaves.
    if body == "Z":
        fail(voice.pending is not None, f"{context}: tie enters a full-measure rest")
        offset = length
    else:
        cursor = 0
        while cursor < len(body):
            if body[cursor].isspace():
                cursor += 1
                continue
            match = TOKEN.match(body, cursor)
            fail(match is None, f"{context}: unsupported token at {body[cursor:cursor + 24]!r}")
            cursor = match.end()
            chord, key = match.group("chord", "key")
            fail(offset >= length, f"{context}: event after the measure end")
            if chord is not None:
                fail(CHORD.fullmatch(chord) is None, f"{context}: unsupported chord {chord!r}")
                voice.chords.append((start + offset, chord))
                continue
            if key is not None:
                key_accidentals(key)
                voice.key = key
                voice.keys.append((start + offset, key))
                local = {}
                continue
            note, acc, octave, tie = match.group("note", "acc", "oct", "tie")
            units = int(match.group("duration") or "1")
            fail(units not in DURATIONS, f"{context}: unsupported duration {units}; split it into tied supported lengths")
            duration = units * unit * 4
            fail(offset + duration > length, f"{context}: note/rest exceeds meter duration")
            fail("," in octave and "'" in octave, f"{context}: mixed octave marks")
            if note == "z":
                fail(bool(acc or octave or tie), f"{context}: a rest cannot have accidentals, octave marks or ties")
                fail(voice.pending is not None, f"{context}: tie enters a rest")
            else:
                letter = note.upper()
                written = 60 + NATURAL[letter] + (12 if note.islower() else 0)
                written += 12 * (octave.count("'") - octave.count(","))
                alteration = local.get(letter, key_accidentals(voice.key)[letter])
                if acc:
                    alteration = {"=": 0, "_": -1, "__": -2, "^": 1, "^^": 2}[acc]
                    local[letter] = alteration
                pitch = written + alteration
                if voice.pending is not None:
                    old_pitch, old_written = voice.pending
                    # An unmarked continuation retains its tied accidental across
                    # a barline. It does not alter later untied notes in that bar.
                    if not acc and written == old_written:
                        pitch = old_pitch
                    fail(pitch != old_pitch, f"{context}: tie changes pitch from {old_pitch} to {pitch}")
                    voice.notes[-1][2] += duration
                else:
                    fail(not 0 <= pitch <= 127, f"{context}: pitch {pitch} is outside MIDI range")
                    voice.notes.append([start + offset, pitch, duration])
                voice.pending = (pitch, written) if tie else None
            offset += duration
    fail(offset != length, f"{context}: duration {offset} quarter notes != meter duration {length}")
    voice.bars.append((start, length, voice.meter))
    voice.time += length


def parse(text: str) -> Score:
    """Fail closed for unsupported tokens; resolve sounding notes, not token counts."""
    lines = text.splitlines()
    fail(len(lines) < 12, "Incomplete native two-voice ABC")
    fail(lines[0:2] != ["X:1", "T:"], "Expected native X:1 and blank T: header")
    fail(not lines[2].startswith("M:"), "Missing header M:")
    meter = meter_value(lines[2][2:])
    unit_match = re.fullmatch(r"L:1/([1-9][0-9]*)", lines[3])
    fail(unit_match is None, "Expected L:1/<power of two>, usually L:1/32")
    denominator = int(unit_match.group(1))
    fail(denominator > 1024 or denominator & (denominator - 1) != 0, "Unsupported L: denominator")
    unit = Fraction(1, denominator)
    tempo_match = re.fullmatch(r"Q:1/4=([1-9][0-9]*)", lines[4])
    fail(tempo_match is None, "Expected integer quarter-note tempo Q:1/4=<BPM>")
    expected_voices = ['V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
                       'V: Ins clef=treble name="Ins Melody" snm="Inst."']
    fail(lines[5:7] != expected_voices, "Preserve native Vocal and Ins voice definitions")
    fail(not lines[7].startswith("K:"), "Missing header K:")
    key = lines[7][2:]
    key_accidentals(key)
    voices = {name: Voice(meter, key, keys=[(Fraction(0), key)]) for name in VOICES}
    music_lines = {}
    cursor = 8
    group = 0
    while cursor < len(lines):
        while cursor < len(lines) and lines[cursor].startswith("% "):
            cursor += 1
        fail(cursor == len(lines), "Dangling section comment without music")
        group += 1
        counts = []
        for name in VOICES:
            context = f"group {group}, {name}"
            fail(cursor >= len(lines) or lines[cursor] != f"V: {name}", f"{context}: expected V: {name}")
            cursor += 1
            voice = voices[name]
            fields = set()
            while cursor < len(lines) and lines[cursor].startswith(("M:", "K:")):
                field_name, value = lines[cursor].split(":", 1)
                fail(field_name in fields, f"{context}: duplicate {field_name}: field")
                fields.add(field_name)
                if field_name == "M":
                    voice.meter = meter_value(value)
                else:
                    key_accidentals(value)
                    voice.key = value
                    voice.keys.append((voice.time, value))
                cursor += 1
            fail(cursor >= len(lines), f"{context}: missing music line")
            line = lines[cursor]
            fail(not line.endswith("|"), f"{context}: music line must end with a plain barline")
            music_lines[cursor] = name
            cursor += 1
            bars = []
            for bar in line[:-1].split("|"):
                bar = bar.strip()
                fail(not bar, f"{context}: empty measure or unsupported double/repeat barline")
                rest = re.fullmatch(r"Z([2-4])?", bar)
                if rest:
                    bars.extend(["Z"] * int(rest.group(1) or "1"))
                else:
                    bars.append(bar)
            fail(not 1 <= len(bars) <= 4, f"{context}: expected 1–4 measures after expanding Z rests")
            counts.append(len(bars))
            for bar in bars:
                parse_bar(bar, voice, unit, f"{context}, bar {len(voice.bars) + 1}")
        fail(counts[0] != counts[1], f"group {group}: voices have different measure counts")
    for name, voice in voices.items():
        fail(voice.pending is not None, f"{name}: unresolved tie at end of score")
    fail(voices["Ins"].chords != [], "Native chord symbols belong in Vocal, not Ins")
    fail(voices["Vocal"].bars != voices["Ins"].bars, "Voice meter/time grids differ")
    fail(voices["Vocal"].keys != voices["Ins"].keys, "Voice key-change timelines differ")
    return Score(text, unit, int(tempo_match.group(1)), voices, music_lines)


def json_value(value):
    if isinstance(value, Fraction):
        return str(value)
    raise TypeError(type(value).__name__)


def parse_abc(text: str) -> Score:
    """Public import entry point; no model load, files, or optional dependencies."""
    return parse(text)


def report(score: Score) -> dict:
    return {
        "scope": "native-dialect structural check; not native serializer reconstruction or audio verification",
        "sha256": hashlib.sha256(score.text.encode()).hexdigest(),
        "bpm": score.bpm, "unit_length": str(score.unit),
        "duration_quarters": str(score.voices["Vocal"].time),
        "nominal_duration_seconds": float(score.voices["Vocal"].time * 60 / score.bpm),
        "voices": {name: {"sounding_notes": len(v.notes), "measures": len(v.bars),
                           "notes": [{"onset_quarters": str(t), "midi_pitch": p, "duration_quarters": str(d)}
                                     for t, p, d in v.notes],
                           "chords": v.chords, "keys": v.keys, "bars": v.bars}
                   for name, v in score.voices.items()},
    }


def compare(before: Score, after: Score, names=VOICES, allow_tempo_change=False) -> dict:
    differences = []
    if before.bpm != after.bpm and not allow_tempo_change:
        differences.append("quarter-note tempo differs")
    for name in names:
        a, b = before.voices[name], after.voices[name]
        if a.bars != b.bars:
            differences.append(f"{name}: bar meter/time grid differs")
        if a.notes != b.notes:
            common = min(len(a.notes), len(b.notes))
            first = next((i for i in range(common) if a.notes[i] != b.notes[i]), common)
            differences.append(f"{name}: sounding notes differ starting at note {first + 1} (pitch, onset or duration)")
    return {"match": not differences, "compared_voices": list(names),
            "tempo_change_allowed": allow_tempo_change, "differences": differences,
            "scope": "exact symbolic melody and meter; no claim about generated audio or unchanged harmony"}


def strip_chords(text: str, keep_voice="both") -> str:
    source = parse(text)
    lines = text.splitlines(keepends=True)
    for index, name in source.music_lines.items():
        def transform(match):
            if match.group("chord") is not None:
                return ""
            if keep_voice != "both" and name != keep_voice and match.group("note") is not None:
                return "z" + match.group("duration")
            return match.group(0)
        lines[index] = TOKEN.sub(transform, lines[index])
    output = "".join(lines)
    result = parse(output)
    names = VOICES if keep_voice == "both" else (keep_voice,)
    invariant = compare(source, result, names)
    fail(not invariant["match"], f"Chord removal changed melody: {invariant['differences']}")
    fail(any(v.chords for v in result.voices.values()), "Chord removal left a chord symbol")
    if keep_voice != "both":
        fail(any(v.notes for name, v in result.voices.items() if name != keep_voice), "Unselected voice was not silenced")
    return output


def split_bars(line: str, context: str) -> list[str]:
    """The measures of one music line, with `Z<n>` full-measure rests expanded."""
    fail(not line.endswith("|"), f"{context}: music line must end with a plain barline")
    bars = []
    for bar in line[:-1].split("|"):
        bar = bar.strip()
        fail(not bar, f"{context}: empty measure")
        rest = re.fullmatch(r"Z([2-4])?", bar)
        bars.extend(["Z"] * int(rest.group(1) or "1") if rest else [bar])
    return bars


def rescale(text: str, factor: int, denominator: int) -> str:
    """Rewrite a score into a finer note unit: every duration times `factor`.

    The studio picks its own `L:` per song -- 1/32 is the common one, 1/16 happens --
    while `hum2abc` always writes 1/16, so a motif and the score it is going into
    routinely disagree. The notes are identical either way; only the spelling changes
    (`c4` at L:1/16 is `c8` at L:1/32). `Z<n>` is a count of whole measures, not a
    duration, and stays put -- which the token pattern already guarantees, since it
    matches only `[A-Ga-gz]`.
    """
    fail(factor < 1, "Rescaling can only go to a finer unit")

    def spell(match):
        if match.group("note") is None:
            return match.group(0)
        length = int(match.group("duration") or 1) * factor
        fail(length not in DURATIONS, f"{match.group(0)!r} becomes an unwritable {length}-unit note")
        return ((match.group("acc") or "") + match.group("note") + match.group("oct")
                + ("" if length == 1 else str(length)) + match.group("tie"))

    lines = text.splitlines(keepends=True)
    for index in parse(text).music_lines:
        lines[index] = TOKEN.sub(spell, lines[index])
    out = "".join(lines).replace(f"L:1/{denominator // factor}\n", f"L:1/{denominator}\n", 1)
    parse(out)  # fails closed if the respelling broke the dialect
    return out


def music_groups(text: str) -> list[dict]:
    """Every `V: <name>` + music line in order, tagged with the `% section` it sits under."""
    groups, section, pending = [], None, None
    for index, line in enumerate(text.splitlines()):
        if line.startswith("% "):
            section = line[2:].strip()
        elif line.startswith("V: ") and " clef=" not in line:
            pending = line[3:].strip()
        elif pending and line.endswith("|"):
            groups.append({"line": index, "voice": pending, "section": section,
                           "bars": split_bars(line, f"line {index + 1}")})
    return groups


def section_blocks(groups: list[dict], name: str) -> list[list[dict]]:
    """Runs of consecutive Vocal lines that sit under the same `% name`.

    A song comes back to its chorus several times, and each return is one place the
    hook belongs -- so blocks are cut where the section changes, never by counting
    lines between them.
    """
    blocks, current, previous = [], [], object()
    for group in (g for g in groups if g["voice"] == "Vocal"):
        if group["section"] != previous:
            if current:
                blocks.append(current)
            current, previous = [], group["section"]
        current.append(group)
    if current:
        blocks.append(current)
    return [b for b in blocks if b[0]["section"] == name and any(x != "Z" for g in b for x in g["bars"])]


def graft(score_text: str, motif_text: str, section="chorus", times=None) -> tuple[str, dict]:
    """Put the owner's own motif into a model-written score, as that section's opening bars.

    The model writes the whole song without ever seeing their tune -- there is no
    "here is a hook, develop it" input; `--abc-file` is all-or-nothing -- so the motif
    goes in afterwards: the song's form, harmony and arrangement stay the model's, and
    the hook is theirs, note for note, every time that section comes round. Measured
    2026-09-21: a 4-bar drawn motif on a 96-bar score sang their line 4 times inside a
    206-second song, where the same motif used alone had been a 26-second song.

    Only `Vocal` changes. `Ins` is left alone, and since this dialect demands both
    voices carry the same measure count, replacement runs as a stream of measures that
    keeps every line's own count intact. A motif too long for the block it is going
    into is an error, never a silent partial graft -- the whole point is that they
    hear *their* phrase.
    """
    source, motif = parse(score_text), parse(motif_text)
    fail(source.voices["Vocal"].meter != motif.voices["Vocal"].meter,
         "Different meters; transcribe the motif in the score's meter")
    if source.unit != motif.unit:
        ratio = motif.unit / source.unit
        fail(ratio.denominator != 1,
             f"Cannot respell a L:1/{motif.unit.denominator} motif into this score's "
             f"L:1/{source.unit.denominator}: the score is the coarser of the two")
        motif_text = rescale(motif_text, int(ratio), source.unit.denominator)
        motif = parse(motif_text)

    motif_vocal = [g for g in music_groups(motif_text) if g["voice"] == "Vocal"]
    fail(not motif_vocal, "Motif has no Vocal line")
    phrase = [bar for bar in motif_vocal[0]["bars"] if bar != "Z"]
    fail(not phrase, "Motif's first Vocal line is all rests")

    groups = music_groups(score_text)
    used = section
    blocks = section_blocks(groups, used)
    if not blocks:  # a score the model laid out without that section still gets the hook
        used = "verse"
        blocks = section_blocks(groups, used)
    fail(not blocks, f"Score has no singable {section!r} or 'verse' line to graft onto")
    if times is not None:
        fail(times < 1, "--times must be at least 1")
        blocks = blocks[:times]

    lines = score_text.splitlines()
    grafted = []
    for block in blocks:
        remaining, spans = list(phrase), []
        for group in block:  # stays inside this block: never spills into the next section
            if not remaining:
                break
            bars = list(group["bars"])
            for slot in range(len(bars)):
                if not remaining:
                    break
                bars[slot] = remaining.pop(0)
            lines[group["line"]] = "|".join(bars) + "|"
            spans.append(group["line"] + 1)
        fail(bool(remaining),
             f"Motif is {len(phrase)} bars; the {used} block at line {block[0]['line'] + 1} holds fewer")
        grafted.append(spans)

    output = "\n".join(lines) + "\n"
    result = parse(output)  # fails closed if the graft broke the dialect
    invariant = compare(source, result, ("Ins",))
    fail(not invariant["match"], f"Graft disturbed the accompaniment: {invariant['differences']}")
    fail(source.voices["Vocal"].bars != result.voices["Vocal"].bars, "Graft changed the measure grid")
    fail(not grafted, "Nothing was grafted")
    return output, {"section": used, "motif_bars": len(phrase),
                    "grafted_at_lines": grafted, "times": len(grafted)}


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="validate and export exact note/meter/chord events")
    inspect.add_argument("score", type=Path)
    inspect.add_argument("--output", type=Path)
    strip = commands.add_parser("strip-chords", help="remove musical chord symbols, preserving header quotes")
    strip.add_argument("source", type=Path)
    strip.add_argument("output", type=Path)
    strip.add_argument("--keep-voice", choices=("both", *VOICES), default="both",
                       help="both preserves all melodies; selecting one replaces the other voice with rests")
    graft_cmd = commands.add_parser("graft", help="put the owner's motif into a model-written score as that section's hook")
    graft_cmd.add_argument("score", type=Path)
    graft_cmd.add_argument("motif", type=Path)
    graft_cmd.add_argument("output", type=Path)
    graft_cmd.add_argument("--section", default="chorus", help="which section's opening bars become theirs (falls back to verse)")
    graft_cmd.add_argument("--times", type=int, help="graft at most this many blocks; default every one")
    diff = commands.add_parser("compare", help="check exact sounding-note/meter invariants after editing")
    diff.add_argument("before", type=Path)
    diff.add_argument("after", type=Path)
    diff.add_argument("--voices", choices=("both", *VOICES), default="both")
    diff.add_argument("--allow-tempo-change", action="store_true")
    diff.add_argument("--output", type=Path)
    args = cli.parse_args()
    try:
        if args.command == "inspect":
            data = report(parse(args.score.read_text(encoding="utf-8")))
        elif args.command == "strip-chords":
            fail(args.source.resolve() == args.output.resolve(), "Write a new file; do not overwrite the source")
            output = strip_chords(args.source.read_text(encoding="utf-8"), args.keep_voice)
            with args.output.open("x", encoding="utf-8") as handle:
                handle.write(output)
            print(json.dumps({"output": str(args.output), "kept_voice": args.keep_voice}))
            return 0
        elif args.command == "graft":
            fail(args.output.resolve() in (args.score.resolve(), args.motif.resolve()),
                 "Write a new file; do not overwrite the score or the motif")
            output, info = graft(args.score.read_text(encoding="utf-8"),
                                 args.motif.read_text(encoding="utf-8"), args.section, args.times)
            with args.output.open("x", encoding="utf-8") as handle:
                handle.write(output)
            print(json.dumps({"output": str(args.output), **info}, ensure_ascii=False))
            return 0
        else:
            names = VOICES if args.voices == "both" else (args.voices,)
            data = compare(parse(args.before.read_text(encoding="utf-8")),
                           parse(args.after.read_text(encoding="utf-8")), names, args.allow_tempo_change)
        rendered = json.dumps(data, indent=2, ensure_ascii=False, default=json_value) + "\n"
        if args.output:
            fail(args.output.exists(), "Report output already exists; choose a new path")
            args.output.write_text(rendered, encoding="utf-8")
        else:
            print(rendered, end="")
        return 1 if data.get("match") is False else 0
    except (AbcError, OSError) as error:
        print(f"ABC check failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
