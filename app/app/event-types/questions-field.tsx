"use client";

import { useState } from "react";
import { maxQuestions, type Question } from "@/lib/core/questions";
import styles from "../settings/settings.module.css";

// The questions builder: one fieldset per question, posted as one JSON field ("questions") that the server action
// parses with parseQuestions. Existing questions keep their id; new ones get theirs on the server from the label.
type Row = { key: number; id?: string; label: string; type: Question["type"]; choices: string; required: boolean };

const toRow = (q: Question, key: number): Row => ({ key, id: q.id, label: q.label, type: q.type, choices: (q.choices ?? []).join("\n"), required: q.required === true });
const toJson = (rows: Row[]) =>
  JSON.stringify(rows.map(({ id, label, type, choices, required }) => ({ id, label, type, required, choices: type === "text" ? undefined : choices.split("\n") })));

export function QuestionsField({ prefix, initial }: { prefix: string; initial: Question[] }) {
  const [rows, setRows] = useState(() => initial.map(toRow));
  const [next, setNext] = useState(initial.length);
  const change = (key: number, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    setRows((list) => [...list, { key: next, label: "", type: "choice", choices: "", required: false }]);
    setNext(next + 1);
  };
  return (
    <fieldset className={styles.field}>
      <legend>Questions</legend>
      <input type="hidden" name="questions" value={toJson(rows)} />
      {rows.length === 0 && <p className={styles.hint}>No questions: invitees give name, email and an optional message.</p>}
      {rows.map((row, i) => {
        const id = `${prefix}-q${row.key}`;
        return (
          <fieldset key={row.key} className={styles.question}>
            <legend>Question {i + 1}</legend>
            <div className={styles.field}>
              <label htmlFor={`${id}-label`}>Label</label>
              <input id={`${id}-label`} value={row.label} maxLength={200} required onChange={(e) => change(row.key, { label: e.target.value })} autoComplete="off" />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-type`}>Answer</label>
              <select id={`${id}-type`} value={row.type} onChange={(e) => change(row.key, { type: e.target.value as Row["type"] })}>
                <option value="choice">One choice</option>
                <option value="multi">Several choices</option>
                <option value="text">Text</option>
              </select>
            </div>
            {row.type !== "text" && (
              <div className={styles.field}>
                <label htmlFor={`${id}-choices`}>Choices</label>
                <textarea
                  id={`${id}-choices`}
                  rows={3}
                  value={row.choices}
                  onChange={(e) => change(row.key, { choices: e.target.value })}
                  aria-describedby={`${id}-choices-hint`}
                />
                <p id={`${id}-choices-hint`} className={styles.hint}>
                  One per line, at most 30.
                </p>
              </div>
            )}
            <label>
              <input type="checkbox" checked={row.required} onChange={(e) => change(row.key, { required: e.target.checked })} /> Required
            </label>
            <div>
              <button type="button" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}>
                Remove question {i + 1}
              </button>
            </div>
          </fieldset>
        );
      })}
      <div>
        <button type="button" onClick={add} disabled={rows.length >= maxQuestions}>
          Add question
        </button>
      </div>
      {initial.length > 0 && <p className={styles.hint}>Removing a question drops its prefilled answer from links and widget pages.</p>}
    </fieldset>
  );
}
