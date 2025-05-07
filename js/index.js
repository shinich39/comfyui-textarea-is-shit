"use strict";

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

let preventSelectionChange = false;

const histories = new WeakMap(), 
  indexes = new WeakMap();

const Settings = {
  "History": true,
  "Navigation": true,
  "Commentify": true,
  "Beautify": true,
  "Minify": true,
  "Bracket": true,
  "StartWithNextToken": true,
  "GlobalPrompt": true,
  "CollapsePrompt": true,
  "OverrideDynamicPrompt": true,
  "PreventSelectionChange": true,
  "Debug": false,
}

const Commands = {
  "ctrl+z": undoHandler, // history
  "ctrl+shift+z": redoHandler, // history
  "tab": tabHandler, // navigation
  "shift+tab": tabHandler, // navigation
  "ctrl+b": beautifyHandler, // beautify
  "ctrl+shift+b": beautifyHandler, // minify
  "ctrl+/": commentifyHandler, // commentify
  "shift+{": bracketHandler, // {
  "shift+(": bracketHandler, // (
  "shift+<": bracketHandler, // <
  "[": bracketHandler, // [
  "backspace": removeBracketHandler,
  // "enter": linebreakHandler,
  // "\'": bracketHandler,
  // "\`": bracketHandler,
  // "shift+\"": bracketHandler,
}

const Brackets = {
  "(": ["(",")"],
  "{": ["{","}"],
  "[": ["[","]"],
  "<": ["<",">"],
  "\"": ["\"","\""],
  "\'": ["\'","\'"],
  "\`": ["\`","\`"],
}

function getCursor(el) {
  return [
    el.selectionStart,
    el.selectionEnd,
  ];
}

function setCursor(el, start, end) {
  el.focus();
  el.setSelectionRange(start, end);
}

function getDepth(str) {
  let n = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === "}" && (!str[i-1] || str[i-1] !== "\\")) {
      n--;
    }
    if (str[i] === "{" && (!str[i-1] || str[i-1] !== "\\")) {
      n++;
    }
  }
  return Math.max(0, n);
}

function parseKey(e) {
  const { key } = e;
  const shiftKey = e.shiftKey;
  const ctrlKey = e.ctrlKey || e.metaKey;
  return { key, shiftKey, ctrlKey };
}

function getKey(e) {
  const { key, ctrlKey, metaKey, shiftKey } = e;
  return (ctrlKey || metaKey ? "ctrl+" : "") + (shiftKey ? "shift+" : "") + key.toLowerCase();
}

function isCommand(e) {
  return !!getCommand(e);
}

function getCommand(e) {
  return Commands[getKey(e)];
}

function stripComments(str) {
  return str.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
}

function setWeights(str, n) {
  const parts = str.split(":");
  let v = parts[0], w = parseFloat(parts[1]);

  if (isNaN(w)) {
    w = Math.pow(1.1, n);
  }

  w = Math.floor(w * 100) / 100;

  if (w === 1) {
    return v;
  } else if (w === 1.1) {
    return `(${v})`;
  } else {
    return `(${v}:${w})`;
  }
}

function calcMaxChars(textarea) {
  const mirror = document.createElement('span');
  document.body.appendChild(mirror);

  const styles = window.getComputedStyle(textarea);
  mirror.style.font = styles.font;
  mirror.style.fontSize = styles.fontSize;
  mirror.style.fontFamily = styles.fontFamily;
  mirror.style.visibility = 'hidden';
  mirror.style.position = 'absolute';
  mirror.style.whiteSpace = 'pre';

  mirror.textContent = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const avgCharWidth = mirror.offsetWidth / mirror.textContent.length;
  document.body.removeChild(mirror);

  const paddingLeft = parseFloat(styles.paddingLeft);
  const paddingRight = parseFloat(styles.paddingRight);
  const contentWidth = textarea.clientWidth - paddingLeft - paddingRight;

  return Math.floor(contentWidth / avgCharWidth);
}

function getGlobalPrompt() {
  const result = {};

  // Note does not have comfyClass
  const notes = app.graph._nodes.filter((item) => 
      item.type === "Note" && item.widgets[0] && item.mode === 0);

  for (const n of notes) {
    const key = n.title;
    const value = n.widgets[0].value;

    if (!result[key]) {
      result[key] = [value];
    } else {
      result[key].push(value);
    }
  }

  return result;
}

function parseString(str) {
  let offset = 0;
  return str.split(/[,()[\]{}|\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = str.indexOf(item, offset);

      offset = index + item.length;

      return {
        value: item,
        start: index,
        end: index + item.length,
      }
    });
}

function parseDynamicPrompt(prompt) {
  let offset = 0, 
      i = prompt.indexOf("{", offset);
      
  while(i > -1) {

    offset = i + 1;

    if (prompt.charAt(i - 1) !== "\\") {

      const closingIndex = prompt.indexOf("}", offset);
      if (closingIndex === -1) {

        if (Settings["Debug"]) {
          console.log(`[comfyui-textarea-is-shit][#${node.id}][${i}]`, `Unexpected token "{"\n${prompt}`);
        }

        break;
      }
  
      const nextOpeningIndex = prompt.indexOf("{", offset);
      if (nextOpeningIndex === -1 || closingIndex < nextOpeningIndex) {
        const items = prompt.substring(i + 1, closingIndex).split("|");
        const item = items[Math.floor(Math.random() * items.length)];
  
        prompt = prompt.substring(0, i) + 
          item + 
          prompt.substring(closingIndex + 1);
          
        offset = 0; 
      }
    }

    i = prompt.indexOf("{", offset);

  }

  return prompt;
}

function parseGlobalPrompt(prompt) {
  const GlobalPrompt = getGlobalPrompt();

  for (const [key, values] of Object.entries(GlobalPrompt).sort((a, b) => b[0].length - a[0].length)) {
    prompt = prompt.replaceAll(`$${key}`, () => parseGlobalPrompt(
      "{" + (values[Math.floor(Math.random() * values.length)] || "") + "}"
    ));
  }

  return prompt;
}

function getNextToken(str, currStart, currEnd, reverse) {
  const tokens = parseString(str);
  if (!reverse) {
    for (let i = 0; i < tokens.length; i++) {
      const { value, start, end } = tokens[i];
      if (start == currStart && end == currEnd) {
        return tokens[i + 1] || tokens[0];
      } else if ((start <= currStart && end >= currStart) || (start > currStart)) {
        return tokens[i];
      }
    }
    return tokens[0];
  } else {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const { value, start, end } = tokens[i];
      if (start == currStart && end == currEnd) {
        return tokens[i - 1] || tokens[tokens.length - 1];
      } else if ((start <= currStart && end >= currStart) || (end < currStart)) {
        return tokens[i];
      }
    }
    return tokens[tokens.length - 1];
  }
}

function getAllTokens(currValue, currStart, currEnd) {
  const tokens = parseString(currValue);
  let result = [];
  for (let i = 0; i < tokens.length; i++) {
    const { value, start, end } = tokens[i];
    if (end > currStart && start < currEnd) {
      result.push(tokens[i]);
    }
  }
  return result;
}

function addHistories(e, ...newHistories) {
  if (!Settings.History) {
    return;
  }

  const el = e.target;

  if (!histories.has(el)) {
    histories.set(el, []);
    indexes.set(el, -1);
  }

  const currHistories = histories.get(el);
  const currIndex = indexes.get(el);

  const nextHistories = currHistories.slice(0, currIndex + 1);

  const currHistory = nextHistories[nextHistories.length - 1];
  
  let toggle = false;
  for (const h of newHistories) {
    if (!toggle) {
      if (
        !currHistory ||
        currHistory.value !== h.value ||
        currHistory.start !== h.start ||
        currHistory.end !== h.end
      ) {
        toggle = true;
      }
    }

    if (toggle) {
      nextHistories.push(h);
    }
  }

  if (toggle) {
    histories.set(el, nextHistories);
    indexes.set(el, nextHistories.length - 1);
  }
}

function undoHandler(e) {
  if (!Settings.History) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const el = e.target;

  const currHistories = histories.get(el);

  if (currHistories) {
    const prevIndex = Math.max(0, indexes.get(el) - 1);
    const currHistory = currHistories[prevIndex];
    if (currHistory) {
      indexes.set(el, prevIndex);

      const { value, start, end } = currHistory;

      el.value = value;
      el.focus();
      el.setSelectionRange(start, end);
    }
  }
}

function redoHandler(e) {
  if (!Settings.History) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const el = e.target;

  const currHistories = histories.get(el);

  if (currHistories) {
    const nextIndex = Math.min(currHistories.length - 1, indexes.get(el) + 1);
    const currHistory = currHistories[nextIndex];
    if (currHistory) {
      indexes.set(el, nextIndex);

      const { value, start, end } = currHistory;

      el.value = value;
      el.focus();
      el.setSelectionRange(start, end);
    }
  }
}

function tabHandler(e) {
  if (!Settings.Navigation) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const { key, shiftKey, ctrlKey } = parseKey(e);
  const elem = e.target;

  const currValue = elem.value;
  const [ currStart, currEnd ] = getCursor(elem);
  const { value, start, end } = getNextToken(currValue, currStart, currEnd, shiftKey);

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  }, {
    value: elem.value,
    start: start,
    end: end,
  });

  setCursor(elem, start, end);
}

function beautifyHandler(e) {
  if (
    (!e.shiftKey && !Settings.Beautify) || 
    (e.shiftKey && !Settings.Minify)
  ) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const { key, shiftKey, ctrlKey } = parseKey(e);
  const elem = e.target;
  const currValue = elem.value;
  const [ currStart, currEnd ] = getCursor(elem);

  // const width = elem.offsetWidth;
  // const height = elem.offsetHeight;
  const max = calcMaxChars(elem) - 1;

  const values = currValue.split(/((?<!\\)[,{}()[\]|])/)
    .map((item) => item.trim())
    .filter(Boolean);

  const parts = [];
  const parents = [parts];
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const target = parents[parents.length - 1];
    if (v === "(") {
      w++;
    } else if (v === ")") {
      w--;
    } else if (v === "[") {
      w--;
    } else if (v === "]") {
      w++;
    } else if (v === "{") {

      // remove empty string
      if (target[target.length - 1] === "") {
        target.pop();
      }

      const n = [];
      target.push(n);
      parents.push(n);
    } else if (v === "}") {
      parents.pop();
    } else if (v === "|") {
      target.push("|");
    } else if (v === ",") {
      // pass
    } else {
      if (target.length === 0) {
        target.push(setWeights(v, w));
      } else if (Array.isArray(target[target.length - 1])) {
        target.push(setWeights(v, w));
      } else if (typeof target[target.length - 1] === "string"){
        target.push(setWeights(v, w))
      }
    }
  }

  if (Settings["Debug"]) {
    console.log(`[comfyui-textarea-is-shit]\n`, parts);
  }

  const writeStr = function(arr, depth, len) {
    let acc = "";

    if (depth > 0) {
      acc += "{";
      len += 1;
    }

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];

      if (Array.isArray(item)) {
        
        if (shiftKey) {

          // if (depth === 0) {
          //   acc += "\n";
          //   len = 0;
          // }

        } else {

          acc += `\n${"  ".repeat(depth)}`;
          len = depth * 2;

        }

        acc += writeStr(item, depth + 1, len);

      } else if (typeof item === "string") {

        if (shiftKey) {

          // add new line to starting of top level dynamic prompt
          // if (depth === 0 && acc.endsWith("}")) {
          //   acc += "\n";
          //   len = 0;
          // }
          
        } else {

          if (item !== "|") {

            // prevent linebreak tokens on same depth
            // if (!acc.endsWith(",")) {
            //   acc += `\n${"  ".repeat(depth)}`;
            //   len = depth * 2;
            // }

            acc += `\n${"  ".repeat(depth)}`;
            len = depth * 2;

          } else {

            if (acc.endsWith("{")) {
              acc += `\n${"  ".repeat(depth)}`;
              len = depth * 2;
            }

          }

        }

        if (max < len + item.length) {

          if (shiftKey) {
            // acc += `\n`;
            // len = 0;
          } else {
            acc += `\n${"  ".repeat(depth)}`;
            len = depth * 2;
          }

        }

        acc += item;
        len += item.length;

        if (item !== "|") {
          acc += ",";
          len += 1;
        }

      }
    }

    if (depth > 0) {

      if (!shiftKey) {
        acc += `\n${"  ".repeat(depth - 1)}`;
        len += (depth - 1) * 2;
      }

      acc += "}";
      len += 1;

    }

    return acc;
  }

  const acc = writeStr(parts, 0, 0).trim();
  
  if (Settings["Debug"]) {
    console.log(`[comfyui-textarea-is-shit]\n`, acc);
  }

  let newValue = acc;
  let newStart = acc.length;
  let newEnd = acc.length;

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  }, {
    value: newValue,
    start: newStart,
    end: newEnd,
  });

  elem.value = newValue;
  setCursor(elem, newStart, newEnd);
}

function commentifyHandler(e) {
  if (!Settings.Commentify) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  // const { key, shiftKey, ctrlKey } = parseKey(e);
  const elem = e.target;

  const currValue = elem.value;
  const [ currStart, currEnd ] = getCursor(elem);

  const lines = currValue.split(/\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    lines[i] += "\n";
  }
 
  const selectedLineIndexes = [];

  // bugfix: cursor on last char
  if (currStart === currEnd && currStart === currValue.length) {
    selectedLineIndexes.push(lines.length - 1);
  } else {
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = offset;
      const end = offset + line.length - 1;
  
      offset += line.length;
  
      if (start > currEnd || end < currStart) {
        continue;
      }
  
      selectedLineIndexes.push(i);
    }
  }

  let isComment = true;
  for (const i of selectedLineIndexes) {
    if (!(/^\/\//.test(lines[i]))) {
      isComment = false;
      break;
    }
  }

  const changes = [];
  for (const i of selectedLineIndexes) {
    const line = lines[i];
    if (!isComment) {
      lines[i] = "// " + line;
    } else {
      lines[i] = line.replace(/^\/\/[^\S\r\n]*/, "");
    }

    changes.push(lines[i].length - line.length);
  }

  const newValue = lines.join("");
  const newStart = currStart + changes[0];
  const newEnd = currEnd + changes.reduce((acc, cur) => acc + cur, 0);

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  }, {
    value: newValue,
    start: newStart,
    end: newEnd,
  });

  elem.value = newValue;
  setCursor(elem, newStart, newEnd);
}

function bracketHandler(e) {
  if (!Settings.Bracket) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const { key, shiftKey, ctrlKey } = parseKey(e);
  const elem = e.target;

  const [opening, closing] = Brackets[key];
  const currValue = elem.value;
  const [ currStart, currEnd ] = getCursor(elem);

  let newValue = currValue;
  let newStart = currStart;
  let newEnd = currEnd;

  let left = currValue.substring(0, currStart);
  let center = currValue.substring(currStart, currEnd);
  let right = currValue.substring(currEnd);

  if (closing === "}" && Settings["StartWithNextToken"] && currStart !== currEnd) {
    newValue = left + opening + center + "|}" + right;
    newStart = left.length + opening.length + center.length + 1;
    newEnd = left.length + opening.length + center.length + 1;
  } else {
    newValue = left + opening + center + closing + right;
    newStart = left.length + opening.length;
    newEnd = left.length + opening.length + center.length;  
  }

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  }, {
    value: newValue,
    start: newStart,
    end: newEnd,
  });

  elem.value = newValue;
  setCursor(elem, newStart, newEnd);
}

function removeBracketHandler(e) {
  if (!Settings.Bracket) {
    return;
  }
  // const { key, shiftKey, ctrlKey } = parseKey(e);
  const elem = e.target;

  const currValue = elem.value;
  const [ currStart, currEnd ] = getCursor(elem);

  if (currStart !== currEnd) {
    return;
  }

  const leftChar = currValue.charAt(currStart - 1);
  const rightChar = currValue.charAt(currStart);
  if (!Brackets[leftChar] || Brackets[leftChar][1] !== rightChar) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  let left = currValue.substring(0, currStart - 1);
  let center = currValue.substring(currStart, currEnd);
  let right = currValue.substring(currEnd + 1);

  let newValue = left + center + right;
  let newStart = currStart - 1;
  let newEnd = currStart - 1;

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  }, {
    value: newValue,
    start: newStart,
    end: newEnd,
  });

  elem.value = newValue;
  setCursor(elem, newStart, newEnd);
}

// conflict with pysssss-autocomplete
// function linebreakHandler(e) {
//   e.preventDefault();
//   e.stopPropagation();

//   // const { key, shiftKey, ctrlKey } = parseKey(e);
//   const elem = e.target;
//   const currValue = elem.value;
//   const [ currStart, currEnd ] = getCursor(elem);
//   const level = getDepth(currValue.substring(0, currStart));

//   let newValue = currValue;
//   let newStart = currStart;
//   let newEnd = currEnd;

//   let left = currValue.substring(0, currStart);
//   let center = "\n" + Array(level * 2).fill(" ").join("");
//   let right = currValue.substring(currEnd);

//   if (right.charAt(0) === "}") {
//     right = "\n" + Array((level - 1) * 2).fill(" ").join("") + right;
//   }

//   newValue = left + center + right;
//   newStart = left.length + center.length;
//   newEnd = left.length + center.length;

//   addHistories(e, {
//     value: currValue,
//     start: currStart,
//     end: currEnd,
//   }, {
//     value: newValue,
//     start: newStart,
//     end: newEnd,
//   });
  
//   elem.value = newValue;
//   setCursor(elem, newStart, newEnd);
// }

async function keydownHandler(e) {
  try {
    // const { key, shiftKey, ctrlKey } = parseKey(e);
    const command = getCommand(e);
    if (command) {
      command(e);
    }
  } catch(err) {
    console.error(err);
  }
}

function clickHandler(e) {
  if (!Settings.History) {
    return;
  }

  setTimeout(function() {
    const currValue = e.target.value;
    const [ currStart, currEnd ] = getCursor(e.target);

    const el = e.target;
  
    if (!histories.has(el)) {
      addHistories(e, {
        value: currValue,
        start: currStart,
        end: currEnd,
      });
    }
  }, 10);
}

function inputHandler(e) {
  const currValue = e.target.value;
  const [ currStart, currEnd ] = getCursor(e.target);

  addHistories(e, {
    value: currValue,
    start: currStart,
    end: currEnd,
  });

  if (preventSelectionChange) {
    e.target.prevSelection = [currStart, currEnd];
  }
}

function preventSelectionChangeHandler(e) {
  if (!Settings["PreventSelectionChange"]) {
    return;
  }
  
  const [ start, end ] = getCursor(e.target);

  if (!preventSelectionChange) {
    e.target.prevSelection = [start, end];
    return;
  }

  if (start === end && (start === e.target.value.length || start === 0)) {

    if (e.target.prevSelection) {
      e.target.setSelectionRange(...e.target.prevSelection);
    }

  }
}

// Fix selected values via DynamicPrompt
// Synchronize workflow values with prompt(output) values
// {red|green|blue} => red
;(() => {
  const origFunc = api.queuePrompt;
  api.queuePrompt = async function(...args) {
    if (Settings["OverrideDynamicPrompt"]) {
      const { output, workflow } = args[1];
      for (const node of app.graph.nodes) {
        if (!node.widgets) {
          continue;
        }
        for (let i = 0; i < node.widgets.length; i++) {
          const widget = node.widgets[i];
          if (!widget.dynamicPrompts) {
            continue;
          }
          const serializedValue = output[node.id]?.inputs[widget.name];
          const serializedNode = workflow.nodes.find((item) => item.id === node.id);
          if (
            serializedValue && 
            serializedNode && 
            typeof serializedNode.widgets_values[i] === typeof serializedValue
          ) {
            serializedNode.widgets_values[i] = serializedValue;
          }
        }
      }
    }

    if (Settings["PreventSelectionChange"]) {
      preventSelectionChange = true;
    }

    return await origFunc.call(api, ...args);
  }

  api.addEventListener("promptQueued", function(...args) {
    if (Settings["PreventSelectionChange"]) {
      preventSelectionChange = false;
    }
  });
})();

app.registerExtension({
	name: "shinich39.TextareaIsShit.Textarea",
  settings: [
    {
      id: 'shinich39.TextareaIsShit.Textarea.Debug',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Debug'],
      name: 'Debug',
      tooltip: 'Write prompts in the browser console for debug.',
      type: 'boolean',
      defaultValue: false,
      onChange: (value) => {
        Settings["Debug"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.OverrideDynamicPrompt',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'OverrideDynamicPrompt'],
      name: 'Override Dynamic Prompt',
      tooltip: 'Override selected token via DynamicPrompt to workflow.',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["OverrideDynamicPrompt"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.CollapsePrompt',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'CollapsePrompt'],
      name: 'Collapse Prompt',
      tooltip: 'Remove empty tokens and multiple whitespaces before generation.',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["CollapsePrompt"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.GlobalPrompt',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'GlobalPrompt'],
      name: 'Global Prompt',
      tooltip: 'Set global prompt to Notes.\nUse to prompt with a title leading "$"\ne.g. $Note',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["GlobalPrompt"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.PreventSelectionChange',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'PreventSelectionChange'],
      name: 'Prevent Selection Change',
      tooltip: 'Prevent selection change when starting generation via Ctrl + Enter.',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["PreventSelectionChange"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.StartWithNextToken',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'StartWithNextToken'],
      name: 'Start with next token',
      tooltip: 'Start with next token when insert curly bracket.',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["StartWithNextToken"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.Bracket',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Bracket'],
      name: 'Bracket',
      tooltip: 'Insert closing bracket with opening bracket.',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["Bracket"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.Minify',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Minify'],
      name: 'Minify',
      tooltip: 'Ctrl + Shift + B',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["Minify"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.Beautify',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Beautify'],
      name: 'Beautify',
      tooltip: 'Ctrl + B',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["Beautify"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.Commentify',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Commentify'],
      name: 'Commentify',
      tooltip: 'Ctrl + \/',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["Commentify"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.Navigation',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'Navigation'],
      name: 'Navigation',
      tooltip: 'Tab, Shift + Tab',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["Navigation"] = value;
      }
    },
    {
      id: 'shinich39.TextareaIsShit.History',
      category: ['TextareaIsShit', '\<textarea\> is garbage', 'History'],
      name: 'History',
      tooltip: 'Ctrl + Z, Ctrl + Shift + Z',
      type: 'boolean',
      defaultValue: true,
      onChange: (value) => {
        Settings["History"] = value;
      }
    },
  ],
	init() {

    const STRING = ComfyWidgets.STRING;
    ComfyWidgets.STRING = function (node, inputName, inputData) {
      const r = STRING.apply(this, arguments);
      if (!inputData[1]?.multiline) {
        return r;
      }
      if (!r.widget?.element) {
        return r;
      }
    
      const elem = r.widget.element;
      elem.addEventListener("keydown", keydownHandler, true);
      elem.addEventListener("input", inputHandler, true);
      elem.addEventListener("click", clickHandler, true);
      elem.addEventListener("selectionchange", preventSelectionChangeHandler, true);

      return r;
    };
	},
  nodeCreated(node) {
		if (node.widgets) {
			// Locate dynamic prompt text widgets
			// Include any widgets with dynamicPrompts set to true, and customtext
			const widgets = node.widgets.filter(
				(n) => n.dynamicPrompts
			);
			for (const widget of widgets) {
				// Override the serialization of the value to resolve dynamic prompts for all widgets supporting it in this node
        const origSerializeValue = widget.serializeValue;
        widget.serializeValue = async function(workflowNode, widgetIndex) {
          let r = await origSerializeValue?.apply(this, arguments) ?? widget.value;

          // Bugfix: Custom-Script presetText.js has overwrite original dynamicPrompt
          if (Settings["GlobalPrompt"]) {
            r = parseGlobalPrompt(r);
          }
          r = stripComments(r);
          r = parseDynamicPrompt(`{${r}}`);

          if (Settings["CollapsePrompt"]) {
            r = r.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").replace(/,+/g, ",").replace(/,/g, ", ");
          }

          // Overwrite the value in the serialized workflow pnginfo
          if (workflowNode?.widgets_values) {
            workflowNode.widgets_values[widgetIndex] = r;
          }

          if (Settings["Debug"]) {
            console.log(`[comfyui-textarea-is-shit][#${node.id}]\n`, r);
          }

          return r;
        }
			}
		}
	},
});