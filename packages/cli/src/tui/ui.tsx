import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { popupWindowStart } from './commands.js';
import { stripMouse } from './mouse.js';

/** A long value shortened in the middle ("/home/me/…/repo") so the start and the end stay readable. */
export function clipMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 8) return text;
  const keepEnd = Math.ceil((max - 1) * 0.6);
  const keepStart = max - 1 - keepEnd;
  return `${chars.slice(0, keepStart).join('')}…${chars.slice(chars.length - keepEnd).join('')}`;
}

export interface MenuItem {
  key: string;
  label: string;
  /** Second column, dimmed (the current value, a hint). */
  detail?: string;
  /** Shown but cannot be chosen. */
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  onSelect: (item: MenuItem) => void;
  /** Esc: go back one level. */
  onCancel?: () => void;
  /** Row of the item to highlight first. */
  initialKey?: string;
  /** Most rows shown at once; the window follows the highlight. */
  maxRows?: number;
  isActive?: boolean;
}

/** An Up/Down list. Enter chooses the highlighted item, Esc cancels. */
export function Menu({ items, onSelect, onCancel, initialKey, maxRows = 10, isActive = true }: MenuProps) {
  const startIndex = Math.max(0, items.findIndex((i) => i.key === initialKey));
  const [index, setIndex] = useState(startIndex);

  // Keep the highlight in range when the list shrinks.
  useEffect(() => {
    if (index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  useInput(
    (_ch, key) => {
      if (key.upArrow) setIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      else if (key.downArrow) setIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      else if (key.return) {
        const item = items[index];
        if (item && !item.disabled) onSelect(item);
      } else if (key.escape) onCancel?.();
    },
    { isActive },
  );

  const start = popupWindowStart(index, items.length, maxRows);
  const shown = items.slice(start, start + maxRows);
  const labelWidth = Math.max(8, ...shown.map((i) => Array.from(i.label).length));

  return (
    <Box flexDirection="column">
      {shown.map((item, offset) => {
        const selected = start + offset === index;
        return (
          <Box key={item.key} gap={2}>
            <Text
              bold={selected}
              inverse={selected}
              dimColor={item.disabled}
              color={selected && !item.disabled ? 'cyan' : undefined}
            >
              {selected ? '>' : ' '} {item.label.padEnd(labelWidth)}
            </Text>
            {item.detail ? (
              <Text dimColor={!selected} wrap="truncate-end">
                {item.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {items.length > maxRows ? (
        <Text dimColor>
          {index + 1}/{items.length}
        </Text>
      ) : null}
    </Box>
  );
}

export interface FieldProps {
  label: string;
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** A one line text input: Enter saves, Esc cancels. A pasted chunk that ends in Enter saves too. */
export function Field({ label, initialValue = '', placeholder, onSubmit, onCancel }: FieldProps) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);

  useInput((rawCh, key) => {
    const ch = stripMouse(rawCh);
    if (key.return) return onSubmit(value);
    if (key.escape) return onCancel();
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
    if (key.ctrl && ch === 'a') return setCursor(0);
    if (key.ctrl && ch === 'e') return setCursor(value.length);
    if (key.ctrl && ch === 'u') {
      setValue('');
      return setCursor(0);
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    if (!key.ctrl && !key.meta && ch) {
      const chunk = ch.replace(/\r\n?/g, '\n');
      const text = chunk.replace(/\n+$/, '').replace(/\n/g, ' ');
      const next = value.slice(0, cursor) + text + value.slice(cursor);
      if (chunk.endsWith('\n')) return onSubmit(next);
      setValue(next);
      setCursor(cursor + text.length);
    }
  });

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {label}:{' '}
      </Text>
      {value.length === 0 && placeholder ? (
        <>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </>
      ) : (
        <>
          <Text>{before}</Text>
          <Text inverse>{at}</Text>
          <Text>{after}</Text>
        </>
      )}
    </Box>
  );
}

/** A full-screen frame: a title row, the body, and a one line key hint. */
export function Screen({
  title,
  subtitle,
  hint,
  width,
  height,
  children,
}: {
  title: string;
  subtitle?: string;
  hint: string;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
        <Text bold color="yellow" wrap="truncate-end">
          {title}
        </Text>
        {subtitle ? (
          <Text dimColor wrap="truncate-end">
            {subtitle}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {children}
      </Box>
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
