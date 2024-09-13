function setFormElementValueWithEvents(elem, value) {
    if (elem instanceof HTMLSelectElement) {
        const valueToString = value.toString();
        const newSelectedIndex = findSelectOptionByText(elem, valueToString);
        if (newSelectedIndex !== null && elem.selectedIndex !== newSelectedIndex) {
            notifyFormElementBeforeWritten(elem);
            elem.selectedIndex = newSelectedIndex;
            notifyFormElementWritten(elem);
        }
    }
    else if (elem instanceof HTMLInputElement && (elem.type === 'radio' || elem.type === 'checkbox')) {
        const valueStringLower = value === null || value === void 0 ? void 0 : value.toString().toLowerCase();
        const shouldCheck = (valueStringLower === "true") || (valueStringLower === "yes") || (valueStringLower === "on");
        if (elem && elem.checked !== shouldCheck) {
            notifyFormElementBeforeWritten(elem);
            elem.checked = shouldCheck;
            notifyFormElementWritten(elem);
        }
    }
    else {
        if (isComboBox(elem)) {
            // TODO: Support datalist by interpreting it as a set of allowed values. When populating
            // the form, only accept suggestions that match one of the allowed values.
            return;
        }
        value = value.toString();
        if (elem.value !== value) {
            notifyFormElementBeforeWritten(elem);
            elem.value = value;
            notifyFormElementWritten(elem);
        }
    }
}
function isComboBox(elem) {
    return !!(elem.list || elem.getAttribute('data-autocomplete'));
}
// Client-side code (e.g., validation) may react when an element value is changed
// We'll trigger the same kinds of events that fire if you type
function notifyFormElementBeforeWritten(elem) {
    elem.dispatchEvent(new CustomEvent('beforeinput', { bubbles: true, detail: { fromSmartComponents: true } }));
}
function notifyFormElementWritten(elem) {
    elem.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { fromSmartComponents: true } }));
    elem.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { fromSmartComponents: true } }));
}
function findSelectOptionByText(selectElem, valueText) {
    const options = Array.from(selectElem.querySelectorAll('option'));
    const exactMatches = options.filter(o => o.textContent === valueText);
    if (exactMatches.length > 0) {
        return options.indexOf(exactMatches[0]);
    }
    const partialMatches = options.filter(o => o.textContent && o.textContent.indexOf(valueText) >= 0);
    if (partialMatches.length === 1) {
        return options.indexOf(partialMatches[0]);
    }
    return null;
}

function registerSmartComboBoxCustomElement() {
    customElements.define('smart-combobox', SmartComboBox);
}
class SmartComboBox extends HTMLElement {
    constructor() {
        super(...arguments);
        this.requestSuggestionsTimeout = 0;
        this.debounceKeystrokesDelay = 250;
        this.currentAbortController = null;
        this.selectedIndex = 0;
    }
    connectedCallback() {
        this.inputElem = this.previousElementSibling;
        if (!(this.inputElem instanceof HTMLInputElement)) {
            throw new Error('smart-combobox must be placed immediately after an input element');
        }
        this.id = `smartcombobox-suggestions-${SmartComboBox.nextSuggestionsElemId++}`;
        this.classList.add('smartcombobox-suggestions');
        this.addEventListener('mousedown', event => {
            if (event.target instanceof HTMLElement && event.target.classList.contains('smartcombobox-suggestion')) {
                this._handleSuggestionSelected(event.target);
            }
        });
        this.inputElem.setAttribute('aria-controls', this.id);
        this._setSuggestions([]);
        this.inputElem.addEventListener('keydown', event => {
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                this._updateSelection({ offset: -1, updateInputToMatch: true });
            }
            else if (event.key === 'ArrowDown') {
                event.preventDefault();
                this._updateSelection({ offset: 1, updateInputToMatch: true });
            }
            else if (event.key === 'Enter') {
                event.preventDefault();
                const suggestion = this.children[this.selectedIndex];
                if (suggestion) {
                    this._handleSuggestionSelected(suggestion);
                }
            }
        });
        this.inputElem.addEventListener('input', event => {
            var _a;
            if (event instanceof CustomEvent && event.detail.fromSmartComponents) {
                return; // When we triggered the update programmatically, that's not a reason to fetch more suggestions
            }
            clearTimeout(this.requestSuggestionsTimeout);
            (_a = this.currentAbortController) === null || _a === void 0 ? void 0 : _a.abort();
            this.currentAbortController = null;
            if (this.inputElem.value === '') {
                this._setSuggestions([]);
            }
            else {
                this.requestSuggestionsTimeout = setTimeout(() => {
                    this._requestSuggestions();
                }, this.debounceKeystrokesDelay);
            }
        });
        this.inputElem.addEventListener('focus', () => this._updateAriaStates());
        this.inputElem.addEventListener('blur', () => this._updateAriaStates());
    }
    async _requestSuggestions() {
        this.currentAbortController = new AbortController();
        const body = {
            inputValue: this.inputElem.value,
            maxResults: this.getAttribute('data-max-suggestions'),
            similarityThreshold: this.getAttribute('data-similarity-threshold'),
        };
        const antiforgeryName = this.getAttribute('data-antiforgery-name');
        if (antiforgeryName) {
            body[antiforgeryName] = this.getAttribute('data-antiforgery-value');
        }
        let response;
        const requestInit = {
            method: 'post',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body),
            signal: this.currentAbortController.signal,
        };
        try {
            // We rely on the URL being pathbase-relative for Blazor, or a ~/... URL that would already
            // be resolved on the server for MVC
            response = await fetch(this.getAttribute('data-suggestions-url'), requestInit);
            const suggestions = await response.json();
            this._setSuggestions(suggestions);
        }
        catch (ex) {
            if (ex instanceof DOMException && ex.name === 'AbortError') {
                return;
            }
            throw ex;
        }
    }
    _setSuggestions(suggestions) {
        while (this.firstElementChild) {
            this.firstElementChild.remove();
        }
        let optionIndex = 0;
        suggestions.forEach(choice => {
            const option = document.createElement('div');
            option.id = `${this.id}_item${optionIndex++}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.classList.add('smartcombobox-suggestion');
            option.textContent = choice;
            this.appendChild(option);
        });
        if (suggestions.length) {
            this._updateSelection({ suggestion: this.children[0] });
            this.style.display = null; // Allow visibility to be controlled by focus rule in CSS
            // We rely on the input not moving relative to its offsetParent while the suggestions
            // are visible. Developers can always put the input directly inside a relatively-positioned
            // container if they need this to work on a fine-grained basis.
            this.style.top = this.inputElem.offsetTop + this.inputElem.offsetHeight + 'px';
            this.style.left = this.inputElem.offsetLeft + 'px';
            this.style.width = this.inputElem.offsetWidth + 'px';
        }
        else {
            this.style.display = 'none';
        }
        this._updateAriaStates();
    }
    _updateAriaStates() {
        // aria-expanded
        const isExpanded = this.firstChild && document.activeElement === this.inputElem;
        this.inputElem.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        // aria-activedescendant
        const suggestion = isExpanded && this.children[this.selectedIndex];
        if (!suggestion) {
            this.inputElem.removeAttribute('aria-activedescendant');
        }
        else {
            this.inputElem.setAttribute('aria-activedescendant', suggestion.id);
        }
    }
    _handleSuggestionSelected(suggestion) {
        this._updateSelection({ suggestion, updateInputToMatch: true });
        this.inputElem.blur();
    }
    _updateSelection(operation) {
        let suggestion = operation.suggestion;
        if (suggestion) {
            this.selectedIndex = Array.from(this.children).indexOf(suggestion);
        }
        else {
            if (isNaN(operation.offset)) {
                throw new Error('Supply either offset or selection element');
            }
            const newIndex = Math.max(0, Math.min(this.children.length - 1, this.selectedIndex + operation.offset));
            if (newIndex === this.selectedIndex) {
                return;
            }
            this.selectedIndex = newIndex;
            suggestion = this.children[newIndex];
        }
        const prevSelectedSuggestion = this.querySelector('.selected');
        if (prevSelectedSuggestion === suggestion && this.inputElem.value === suggestion.textContent) {
            return;
        }
        prevSelectedSuggestion === null || prevSelectedSuggestion === void 0 ? void 0 : prevSelectedSuggestion.setAttribute('aria-selected', 'false');
        prevSelectedSuggestion === null || prevSelectedSuggestion === void 0 ? void 0 : prevSelectedSuggestion.classList.remove('selected');
        suggestion.setAttribute('aria-selected', 'true');
        suggestion.classList.add('selected');
        if (suggestion['scrollIntoViewIfNeeded']) {
            suggestion['scrollIntoViewIfNeeded'](false);
        }
        else {
            // Firefox doesn't support scrollIntoViewIfNeeded, so we fall back on scrollIntoView.
            // This will align the top of the suggestion with the top of the scrollable area.
            suggestion.scrollIntoView();
        }
        this._updateAriaStates();
        if (operation.updateInputToMatch) {
            setFormElementValueWithEvents(this.inputElem, suggestion.textContent || '');
        }
    }
}
SmartComboBox.nextSuggestionsElemId = 0;

function registerSmartPasteClickHandler() {
    document.addEventListener('click', (evt) => {
        const target = evt.target;
        if (target instanceof Element) {
            const button = target.closest('button[data-smart-paste-trigger=true]');
            if (button instanceof HTMLButtonElement) {
                performSmartPaste(button);
            }
        }
    });
}
async function performSmartPaste(button) {
    const form = button.closest('form');
    if (!form) {
        console.error('A smart paste button was clicked, but it is not inside a form');
        return;
    }
    const formConfig = extractFormConfig(form);
    if (formConfig.length == 0) {
        console.warn('A smart paste button was clicked, but no fields were found in its form');
        return;
    }
    const clipboardContents = await readClipboardText();
    if (!clipboardContents) {
        console.info('A smart paste button was clicked, but no data was found on the clipboard');
        return;
    }
    try {
        button.disabled = true;
        const response = await getSmartPasteResponse(button, formConfig, clipboardContents);
        const responseText = await response.text();
        populateForm(form, formConfig, responseText);
    }
    finally {
        button.disabled = false;
    }
}
function populateForm(form, formConfig, responseText) {
    const resultData = {};
    const prefix = 'FIELD ';
    let prevFieldKey = null;
    responseText.split('\n').forEach(line => {
        if (line.startsWith(prefix)) {
            const keyValuePair = line.substring(prefix.length).split('^^^');
            if (keyValuePair.length === 2) {
                resultData[keyValuePair[0]] = keyValuePair[1];
                prevFieldKey = keyValuePair[0];
            }
        }
        else if (prevFieldKey) {
            resultData[prevFieldKey] += '\n' + line;
        }
    });
    formConfig.forEach(field => {
        let value = resultData[field.identifier];
        if (value !== undefined) {
            value = value.trim();
            if (value === 'NO_DATA') {
                // It's usually better to leave the existing field data in place, since there might be useful
                // values in unrelated fields. It would be nice if the inference could conclusively determine
                // cases when a field should be cleared, but in most cases it can't distinguish "no information
                // available" from "the value should definitely be blanked out".
                return;
            }
            if (field.element instanceof HTMLInputElement && field.element.type === 'radio') {
                // Radio is a bit more complex than the others as it's not just a single form element
                // We have to find the one corresponding to the new value, which in turn depends on
                // how we're interpreting the field description
                const radioInputToSelect = findInputRadioByText(form, field.element.name, value);
                if (radioInputToSelect) {
                    setFormElementValueWithEvents(radioInputToSelect, true);
                }
            }
            else {
                setFormElementValueWithEvents(field.element, value);
            }
        }
    });
}
function findInputRadioByText(form, radioGroupName, valueText) {
    const candidates = Array.from(form.querySelectorAll('input[type=radio]'))
        .filter(e => e instanceof HTMLInputElement && e.name === radioGroupName)
        .map(e => ({ elem: e, text: inferFieldDescription(form, e) }));
    const exactMatches = candidates.filter(o => o.text === valueText);
    if (exactMatches.length > 0) {
        return exactMatches[0].elem;
    }
    const partialMatches = candidates.filter(o => o.text && o.text.indexOf(valueText) >= 0);
    if (partialMatches.length === 1) {
        return partialMatches[0].elem;
    }
    return null;
}
async function readClipboardText() {
    const fake = document.getElementById('fake-clipboard');
    if (fake === null || fake === void 0 ? void 0 : fake.value) {
        return fake.value;
    }
    if (!navigator.clipboard.readText) {
        alert('The current browser does not support reading the clipboard.\n\nTODO: Implement alternate UI for this case.');
        return null;
    }
    return navigator.clipboard.readText();
}
function extractFormConfig(form) {
    const fields = [];
    let unidentifiedCount = 0;
    form.querySelectorAll('input, select, textarea').forEach(element => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
            return;
        }
        if (element.type === 'hidden' || isComboBox(element)) {
            return;
        }
        const isRadio = element.type === 'radio';
        const identifier = isRadio
            ? element.name
            : element.id || element.name || `unidentified_${++unidentifiedCount}`;
        // Only include one field for each related set of radio buttons
        if (isRadio && fields.find(f => f.identifier === identifier)) {
            return;
        }
        let description = null;
        if (!isRadio) {
            description = inferFieldDescription(form, element);
            if (!description) {
                // If we can't say anything about what this field represents, we have to exclude it
                return;
            }
        }
        const fieldEntry = {
            identifier: identifier,
            description: description,
            element: element,
            type: element.type === 'checkbox' ? 'boolean'
                : element.type === 'number' ? 'number' : 'string',
        };
        if (element instanceof HTMLSelectElement) {
            const options = Array.prototype.filter.call(element.querySelectorAll('option'), o => !!o.value);
            fieldEntry.allowedValues = Array.prototype.map.call(options, o => o.textContent);
            fieldEntry.type = 'fixed-choices';
        }
        else if (isRadio) {
            fieldEntry.allowedValues = [];
            fieldEntry.type = 'fixed-choices';
            Array.prototype.forEach.call(form.querySelectorAll('input[type=radio]'), e => {
                if (e.name === identifier) {
                    const choiceDescription = inferFieldDescription(form, e);
                    if (choiceDescription) {
                        fieldEntry.allowedValues.push(choiceDescription);
                    }
                }
            });
        }
        fields.push(fieldEntry);
    });
    return fields;
}
function inferFieldDescription(form, element) {
    // If there's explicit config, use it
    const smartPasteDescription = element.getAttribute('data-smartpaste-description');
    if (smartPasteDescription) {
        return smartPasteDescription;
    }
    // If there's an explicit label, use it
    const labels = element.id && form.querySelectorAll(`label[for='${element.id}']`);
    if (labels && labels.length === 1) {
        return labels[0].textContent.trim();
    }
    // Try searching up the DOM hierarchy to look for some container that only contains
    // this one field and has text
    let candidateContainer = element.parentElement;
    while (candidateContainer && candidateContainer !== form.parentElement) {
        const inputsInContainer = candidateContainer.querySelectorAll('input, select, textarea');
        if (inputsInContainer.length === 1 && inputsInContainer[0] === element) {
            // Here's a container in which this element is the only input. Any text here
            // will be assumed to describe the input.
            let text = candidateContainer.textContent.replace(/\s+/g, ' ').trim();
            if (text) {
                return text;
            }
        }
        candidateContainer = candidateContainer.parentElement;
    }
    // Fall back on name (because that's what would be bound on the server) or even ID
    // If even these have no data, we won't be able to use the field
    return element.getAttribute('name') || element.id;
}
async function getSmartPasteResponse(button, formConfig, clipboardContents) {
    const formFields = formConfig.map(entry => restrictProperties(entry, ['identifier', 'description', 'allowedValues', 'type']));
    const body = {
        dataJson: JSON.stringify({
            formFields,
            clipboardContents,
        })
    };
    const antiforgeryName = button.getAttribute('data-antiforgery-name');
    if (antiforgeryName) {
        body[antiforgeryName] = button.getAttribute('data-antiforgery-value');
    }
    // We rely on the URL being pathbase-relative for Blazor, or a ~/... URL that would already
    // be resolved on the server for MVC
    const url = button.getAttribute('data-url');
    return fetch(url, {
        method: 'post',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body)
    });
}
function restrictProperties(object, propertyNames) {
    const result = {};
    propertyNames.forEach(propertyName => {
        const value = object[propertyName];
        if (value !== undefined) {
            result[propertyName] = value;
        }
    });
    return result;
}

var attributes = ['borderBottomWidth', 'borderLeftWidth', 'borderRightWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopWidth', 'boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'height', 'letterSpacing', 'lineHeight', 'marginBottom', 'marginLeft', 'marginRight', 'marginTop', 'outlineWidth', 'overflow', 'overflowX', 'overflowY', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop', 'textAlign', 'textOverflow', 'textTransform', 'whiteSpace', 'wordBreak', 'wordWrap'];
/**
 * Create a mirror
 *
 * @param {Element} element The element
 * @param {string} html The html
 *
 * @return {object} The mirror object
 */

var createMirror = function createMirror(element, html) {
  /**
   * The mirror element
   */
  var mirror = document.createElement('div');
  /**
   * Create the CSS for the mirror object
   *
   * @return {object} The style object
   */

  var mirrorCss = function mirrorCss() {
    var css = {
      position: 'absolute',
      left: -9999,
      top: 0,
      zIndex: -2000
    };

    if (element.tagName === 'TEXTAREA') {
      attributes.push('width');
    }

    attributes.forEach(function (attr) {
      css[attr] = getComputedStyle(element)[attr];
    });
    return css;
  };
  /**
   * Initialize the mirror
   *
   * @param {string} html The html
   *
   * @return {void}
   */


  var initialize = function initialize(html) {
    var styles = mirrorCss();
    Object.keys(styles).forEach(function (key) {
      mirror.style[key] = styles[key];
    });
    mirror.innerHTML = html;
    element.parentNode.insertBefore(mirror, element.nextSibling);
  };
  /**
   * Get the rect
   *
   * @return {Rect} The bounding rect
   */


  var rect = function rect() {
    var marker = mirror.ownerDocument.getElementById('caret-position-marker');
    var boundingRect = {
      left: marker.offsetLeft,
      top: marker.offsetTop,
      height: marker.offsetHeight
    };
    mirror.parentNode.removeChild(mirror);
    return boundingRect;
  };

  initialize(html);
  return {
    rect: rect
  };
};

function _typeof(obj) {
  "@babel/helpers - typeof";

  if (typeof Symbol === "function" && typeof Symbol.iterator === "symbol") {
    _typeof = function (obj) {
      return typeof obj;
    };
  } else {
    _typeof = function (obj) {
      return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj;
    };
  }

  return _typeof(obj);
}

/**
 * Check if a DOM Element is content editable
 *
 * @param {Element} element  The DOM element
 *
 * @return {bool} If it is content editable
 */
var isContentEditable = function isContentEditable(element) {
  return !!(element.contentEditable ? element.contentEditable === 'true' : element.getAttribute('contenteditable') === 'true');
};
/**
 * Get the context from settings passed in
 *
 * @param {object} settings The settings object
 *
 * @return {object} window and document
 */

var getContext = function getContext() {
  var settings = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
  var customPos = settings.customPos,
      iframe = settings.iframe,
      noShadowCaret = settings.noShadowCaret;

  if (iframe) {
    return {
      iframe: iframe,
      window: iframe.contentWindow,
      document: iframe.contentDocument || iframe.contentWindow.document,
      noShadowCaret: noShadowCaret,
      customPos: customPos
    };
  }

  return {
    window: window,
    document: document,
    noShadowCaret: noShadowCaret,
    customPos: customPos
  };
};
/**
 * Get the offset of an element
 *
 * @param {Element} element The DOM element
 * @param {object} ctx The context
 *
 * @return {object} top and left
 */

var getOffset = function getOffset(element, ctx) {
  var win = ctx && ctx.window || window;
  var doc = ctx && ctx.document || document;
  var rect = element.getBoundingClientRect();
  var docEl = doc.documentElement;
  var scrollLeft = win.pageXOffset || docEl.scrollLeft;
  var scrollTop = win.pageYOffset || docEl.scrollTop;
  return {
    top: rect.top + scrollTop,
    left: rect.left + scrollLeft
  };
};
/**
 * Check if a value is an object
 *
 * @param {any} value The value to check
 *
 * @return {bool} If it is an object
 */

var isObject = function isObject(value) {
  return _typeof(value) === 'object' && value !== null;
};

/**
 * Create a Input caret object.
 *
 * @param {Element} element The element
 * @param {Object} ctx The context
 */

var createInputCaret = function createInputCaret(element, ctx) {
  /**
   * Get the current position
   *
   * @returns {int} The caret position
   */
  var getPos = function getPos() {
    return element.selectionStart;
  };
  /**
   * Set the position
   *
   * @param {int} pos The position
   *
   * @return {Element} The element
   */


  var setPos = function setPos(pos) {
    element.setSelectionRange(pos, pos);
    return element;
  };
  /**
   * The offset
   *
   * @param {int} pos The position
   *
   * @return {object} The offset
   */


  var getOffset$1 = function getOffset$1(pos) {
    var rect = getOffset(element);
    var position = getPosition(pos);
    return {
      top: rect.top + position.top + ctx.document.body.scrollTop,
      left: rect.left + position.left + ctx.document.body.scrollLeft,
      height: position.height
    };
  };
  /**
   * Get the current position
   *
   * @param {int} pos The position
   *
   * @return {object} The position
   */


  var getPosition = function getPosition(pos) {
    var format = function format(val) {
      var value = val.replace(/<|>|`|"|&/g, '?').replace(/\r\n|\r|\n/g, '<br/>');
      return value;
    };

    if (ctx.customPos || ctx.customPos === 0) {
      pos = ctx.customPos;
    }

    var position = pos === undefined ? getPos() : pos;
    var startRange = element.value.slice(0, position);
    var endRange = element.value.slice(position);
    var html = "<span style=\"position: relative; display: inline;\">".concat(format(startRange), "</span>");
    html += '<span id="caret-position-marker" style="position: relative; display: inline;">|</span>';
    html += "<span style=\"position: relative; display: inline;\">".concat(format(endRange), "</span>");
    var mirror = createMirror(element, html);
    var rect = mirror.rect();
    rect.pos = getPos();
    return rect;
  };

  return {
    getPos: getPos,
    setPos: setPos,
    getOffset: getOffset$1,
    getPosition: getPosition
  };
};

/**
 * Create an Editable Caret
 * @param {Element} element The editable element
 * @param {object|null} ctx The context
 *
 * @return {EditableCaret}
 */
var createEditableCaret = function createEditableCaret(element, ctx) {
  /**
   * Set the caret position
   *
   * @param {int} pos The position to se
   *
   * @return {Element} The element
   */
  var setPos = function setPos(pos) {
    var sel = ctx.window.getSelection();

    if (sel) {
      var offset = 0;
      var found = false;

      var find = function find(position, parent) {
        for (var i = 0; i < parent.childNodes.length; i++) {
          var node = parent.childNodes[i];

          if (found) {
            break;
          }

          if (node.nodeType === 3) {
            if (offset + node.length >= position) {
              found = true;
              var range = ctx.document.createRange();
              range.setStart(node, position - offset);
              sel.removeAllRanges();
              sel.addRange(range);
              break;
            } else {
              offset += node.length;
            }
          } else {
            find(pos, node);
          }
        }
      };

      find(pos, element);
    }

    return element;
  };
  /**
   * Get the offset
   *
   * @return {object} The offset
   */


  var getOffset = function getOffset() {
    var range = getRange();
    var offset = {
      height: 0,
      left: 0,
      right: 0
    };

    if (!range) {
      return offset;
    }

    var hasCustomPos = ctx.customPos || ctx.customPos === 0; // endContainer in Firefox would be the element at the start of
    // the line

    if (range.endOffset - 1 > 0 && range.endContainer !== element || hasCustomPos) {
      var clonedRange = range.cloneRange();
      var fixedPosition = hasCustomPos ? ctx.customPos : range.endOffset;
      clonedRange.setStart(range.endContainer, fixedPosition - 1 < 0 ? 0 : fixedPosition - 1);
      clonedRange.setEnd(range.endContainer, fixedPosition);
      var rect = clonedRange.getBoundingClientRect();
      offset = {
        height: rect.height,
        left: rect.left + rect.width,
        top: rect.top
      };
      clonedRange.detach();
    }

    if ((!offset || offset && offset.height === 0) && !ctx.noShadowCaret) {
      var _clonedRange = range.cloneRange();

      var shadowCaret = ctx.document.createTextNode('|');

      _clonedRange.insertNode(shadowCaret);

      _clonedRange.selectNode(shadowCaret);

      var _rect = _clonedRange.getBoundingClientRect();

      offset = {
        height: _rect.height,
        left: _rect.left,
        top: _rect.top
      };
      shadowCaret.parentNode.removeChild(shadowCaret);

      _clonedRange.detach();
    }

    if (offset) {
      var doc = ctx.document.documentElement;
      offset.top += ctx.window.pageYOffset - (doc.clientTop || 0);
      offset.left += ctx.window.pageXOffset - (doc.clientLeft || 0);
    }

    return offset;
  };
  /**
   * Get the position
   *
   * @return {object} The position
   */


  var getPosition = function getPosition() {
    var offset = getOffset();
    var pos = getPos();
    var rect = element.getBoundingClientRect();
    var inputOffset = {
      top: rect.top + ctx.document.body.scrollTop,
      left: rect.left + ctx.document.body.scrollLeft
    };
    offset.left -= inputOffset.left;
    offset.top -= inputOffset.top;
    offset.pos = pos;
    return offset;
  };
  /**
   * Get the range
   *
   * @return {Range|null}
   */


  var getRange = function getRange() {
    if (!ctx.window.getSelection) {
      return;
    }

    var sel = ctx.window.getSelection();
    return sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  };
  /**
   * Get the caret position
   *
   * @return {int} The position
   */


  var getPos = function getPos() {
    var range = getRange();
    var clonedRange = range.cloneRange();
    clonedRange.selectNodeContents(element);
    clonedRange.setEnd(range.endContainer, range.endOffset);
    var pos = clonedRange.toString().length;
    clonedRange.detach();
    return pos;
  };

  return {
    getPos: getPos,
    setPos: setPos,
    getPosition: getPosition,
    getOffset: getOffset,
    getRange: getRange
  };
};

var createCaret = function createCaret(element, ctx) {
  if (isContentEditable(element)) {
    return createEditableCaret(element, ctx);
  }

  return createInputCaret(element, ctx);
};

var position = function position(element, value) {
  var settings = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  var options = settings;

  if (isObject(value)) {
    options = value;
    value = null;
  }

  var ctx = getContext(options);
  var caret = createCaret(element, ctx);

  if (value || value === 0) {
    return caret.setPos(value);
  }

  return caret.getPosition();
};

function scrollTextAreaDownToCaretIfNeeded(textArea) {
    // Note that this only scrolls *down*, because that's the only scenario after a suggestion is accepted
    const pos = position(textArea);
    const lineHeightInPixels = parseFloat(window.getComputedStyle(textArea).lineHeight);
    if (pos.top > textArea.clientHeight + textArea.scrollTop - lineHeightInPixels) {
        textArea.scrollTop = pos.top - textArea.clientHeight + lineHeightInPixels;
    }
}
function getCaretOffsetFromOffsetParent(elem) {
    const elemStyle = window.getComputedStyle(elem);
    const pos = position(elem);
    return {
        top: pos.top + parseFloat(elemStyle.borderTopWidth) + elem.offsetTop - elem.scrollTop,
        left: pos.left + parseFloat(elemStyle.borderLeftWidth) + elem.offsetLeft - elem.scrollLeft - 0.25,
        height: pos.height,
        elemStyle: elemStyle,
    };
}
function insertTextAtCaretPosition(textArea, text) {
    // Even though document.execCommand is deprecated, it's still the best way to insert text, because it's
    // the only way that interacts correctly with the undo buffer. If we have to fall back on mutating
    // the .value property directly, it works but erases the undo buffer.
    if (document.execCommand) {
        document.execCommand('insertText', false, text);
    }
    else {
        let caretPos = textArea.selectionStart;
        textArea.value = textArea.value.substring(0, caretPos)
            + text
            + textArea.value.substring(textArea.selectionEnd);
        caretPos += text.length;
        textArea.setSelectionRange(caretPos, caretPos);
    }
}

class InlineSuggestionDisplay {
    constructor(owner, textArea) {
        this.owner = owner;
        this.textArea = textArea;
        this.latestSuggestionText = '';
        this.suggestionStartPos = null;
        this.suggestionEndPos = null;
        this.fakeCaret = null;
        // When any other JS code asks for the value of the textarea, we want to return the value
        // without any pending suggestion, otherwise it will break things like bindings
        this.originalValueProperty = findPropertyRecursive(textArea, 'value');
        const self = this;
        Object.defineProperty(textArea, 'value', {
            get() {
                const trueValue = self.originalValueProperty.get.call(textArea);
                return self.isShowing()
                    ? trueValue.substring(0, self.suggestionStartPos) + trueValue.substring(self.suggestionEndPos)
                    : trueValue;
            },
            set(v) {
                self.originalValueProperty.set.call(textArea, v);
            }
        });
    }
    get valueIncludingSuggestion() {
        return this.originalValueProperty.get.call(this.textArea);
    }
    set valueIncludingSuggestion(val) {
        this.originalValueProperty.set.call(this.textArea, val);
    }
    isShowing() {
        return this.suggestionStartPos !== null;
    }
    show(suggestion) {
        var _a;
        this.latestSuggestionText = suggestion;
        this.suggestionStartPos = this.textArea.selectionStart;
        this.suggestionEndPos = this.suggestionStartPos + suggestion.length;
        this.textArea.setAttribute('data-suggestion-visible', '');
        this.valueIncludingSuggestion = this.valueIncludingSuggestion.substring(0, this.suggestionStartPos) + suggestion + this.valueIncludingSuggestion.substring(this.suggestionStartPos);
        this.textArea.setSelectionRange(this.suggestionStartPos, this.suggestionEndPos);
        (_a = this.fakeCaret) !== null && _a !== void 0 ? _a : (this.fakeCaret = new FakeCaret(this.owner, this.textArea));
        this.fakeCaret.show();
    }
    get currentSuggestion() {
        return this.latestSuggestionText;
    }
    accept() {
        var _a;
        this.textArea.setSelectionRange(this.suggestionEndPos, this.suggestionEndPos);
        this.suggestionStartPos = null;
        this.suggestionEndPos = null;
        (_a = this.fakeCaret) === null || _a === void 0 ? void 0 : _a.hide();
        this.textArea.removeAttribute('data-suggestion-visible');
        // The newly-inserted text could be so long that the new caret position is off the bottom of the textarea.
        // It won't scroll to the new caret position by default
        scrollTextAreaDownToCaretIfNeeded(this.textArea);
    }
    reject() {
        var _a;
        if (!this.isShowing()) {
            return; // No suggestion is shown
        }
        const prevSelectionStart = this.textArea.selectionStart;
        const prevSelectionEnd = this.textArea.selectionEnd;
        this.valueIncludingSuggestion = this.valueIncludingSuggestion.substring(0, this.suggestionStartPos) + this.valueIncludingSuggestion.substring(this.suggestionEndPos);
        if (this.suggestionStartPos === prevSelectionStart && this.suggestionEndPos === prevSelectionEnd) {
            // For most interactions we don't need to do anything to preserve the cursor position, but for
            // 'scroll' events we do (because the interaction isn't going to set a cursor position naturally)
            this.textArea.setSelectionRange(prevSelectionStart, prevSelectionStart /* not 'end' because we removed the suggestion */);
        }
        this.suggestionStartPos = null;
        this.suggestionEndPos = null;
        this.textArea.removeAttribute('data-suggestion-visible');
        (_a = this.fakeCaret) === null || _a === void 0 ? void 0 : _a.hide();
    }
}
class FakeCaret {
    constructor(owner, textArea) {
        this.textArea = textArea;
        this.caretDiv = document.createElement('div');
        this.caretDiv.classList.add('smart-textarea-caret');
        owner.appendChild(this.caretDiv);
    }
    show() {
        const caretOffset = getCaretOffsetFromOffsetParent(this.textArea);
        const style = this.caretDiv.style;
        style.display = 'block';
        style.top = caretOffset.top + 'px';
        style.left = caretOffset.left + 'px';
        style.height = caretOffset.height + 'px';
        style.zIndex = this.textArea.style.zIndex;
        style.backgroundColor = caretOffset.elemStyle.caretColor;
    }
    hide() {
        this.caretDiv.style.display = 'none';
    }
}
function findPropertyRecursive(obj, propName) {
    while (obj) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, propName);
        if (descriptor) {
            return descriptor;
        }
        obj = Object.getPrototypeOf(obj);
    }
    throw new Error(`Property ${propName} not found on object or its prototype chain`);
}

class OverlaySuggestionDisplay {
    constructor(owner, textArea) {
        this.textArea = textArea;
        this.latestSuggestionText = '';
        this.suggestionElement = document.createElement('div');
        this.suggestionElement.classList.add('smart-textarea-suggestion-overlay');
        this.suggestionElement.addEventListener('mousedown', e => this.handleSuggestionClicked(e));
        this.suggestionElement.addEventListener('touchend', e => this.handleSuggestionClicked(e));
        this.suggestionPrefixElement = document.createElement('span');
        this.suggestionTextElement = document.createElement('span');
        this.suggestionElement.appendChild(this.suggestionPrefixElement);
        this.suggestionElement.appendChild(this.suggestionTextElement);
        this.suggestionPrefixElement.style.opacity = '0.3';
        const computedStyle = window.getComputedStyle(this.textArea);
        this.suggestionElement.style.font = computedStyle.font;
        this.suggestionElement.style.marginTop = (parseFloat(computedStyle.fontSize) * 1.4) + 'px';
        owner.appendChild(this.suggestionElement);
    }
    get currentSuggestion() {
        return this.latestSuggestionText;
    }
    show(suggestion) {
        this.latestSuggestionText = suggestion;
        this.suggestionPrefixElement.textContent = suggestion[0] != ' ' ? getCurrentIncompleteWord(this.textArea, 20) : '';
        this.suggestionTextElement.textContent = suggestion;
        const caretOffset = getCaretOffsetFromOffsetParent(this.textArea);
        const style = this.suggestionElement.style;
        style.minWidth = null;
        this.suggestionElement.classList.add('smart-textarea-suggestion-overlay-visible');
        style.zIndex = this.textArea.style.zIndex;
        style.top = caretOffset.top + 'px';
        // If the horizontal position is already close enough, leave it alone. Otherwise it
        // can jiggle annoyingly due to inaccuracies in measuring the caret position.
        const newLeftPos = caretOffset.left - this.suggestionPrefixElement.offsetWidth;
        if (!style.left || Math.abs(parseFloat(style.left) - newLeftPos) > 10) {
            style.left = newLeftPos + 'px';
        }
        this.showing = true;
        // Normally we're happy for the overlay to take up as much width as it can up to the edge of the page.
        // However, if it's too narrow (because the edge of the page is already too close), it will wrap onto
        // many lines. In this case we'll force it to get wider, and then we have to move it further left to
        // avoid spilling off the screen.
        const suggestionComputedStyle = window.getComputedStyle(this.suggestionElement);
        const numLinesOfText = Math.round((this.suggestionElement.offsetHeight - parseFloat(suggestionComputedStyle.paddingTop) - parseFloat(suggestionComputedStyle.paddingBottom))
            / parseFloat(suggestionComputedStyle.lineHeight));
        if (numLinesOfText > 2) {
            const oldWidth = this.suggestionElement.offsetWidth;
            style.minWidth = `calc(min(70vw, ${(numLinesOfText * oldWidth / 2)}px))`; // Aim for 2 lines, but don't get wider than 70% of the screen
        }
        // If the suggestion is too far to the right, move it left so it's not off the screen
        const suggestionClientRect = this.suggestionElement.getBoundingClientRect();
        if (suggestionClientRect.right > document.body.clientWidth - 20) {
            style.left = `calc(${parseFloat(style.left) - (suggestionClientRect.right - document.body.clientWidth)}px - 2rem)`;
        }
    }
    accept() {
        if (!this.showing) {
            return;
        }
        insertTextAtCaretPosition(this.textArea, this.currentSuggestion);
        // The newly-inserted text could be so long that the new caret position is off the bottom of the textarea.
        // It won't scroll to the new caret position by default
        scrollTextAreaDownToCaretIfNeeded(this.textArea);
        this.hide();
    }
    reject() {
        this.hide();
    }
    hide() {
        if (this.showing) {
            this.showing = false;
            this.suggestionElement.classList.remove('smart-textarea-suggestion-overlay-visible');
        }
    }
    isShowing() {
        return this.showing;
    }
    handleSuggestionClicked(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.accept();
    }
}
function getCurrentIncompleteWord(textArea, maxLength) {
    const text = textArea.value;
    const caretPos = textArea.selectionStart;
    // Not all languages have words separated by spaces. Imposing the maxlength rule
    // means we'll not show the prefix for those languages if you're in the middle
    // of longer text (and ensures we don't search through a long block), which is ideal.
    for (let i = caretPos - 1; i > caretPos - maxLength; i--) {
        if (i < 0 || text[i].match(/\s/)) {
            return text.substring(i + 1, caretPos);
        }
    }
    return '';
}

function registerSmartTextAreaCustomElement() {
    customElements.define('smart-textarea', SmartTextArea);
}
class SmartTextArea extends HTMLElement {
    constructor() {
        super(...arguments);
        this.typingDebounceTimeout = null;
    }
    connectedCallback() {
        if (!(this.previousElementSibling instanceof HTMLTextAreaElement)) {
            throw new Error('smart-textarea must be rendered immediately after a textarea element');
        }
        this.textArea = this.previousElementSibling;
        this.suggestionDisplay = shouldUseInlineSuggestions(this.textArea)
            ? new InlineSuggestionDisplay(this, this.textArea)
            : new OverlaySuggestionDisplay(this, this.textArea);
        this.textArea.addEventListener('keydown', e => this.handleKeyDown(e));
        this.textArea.addEventListener('keyup', e => this.handleKeyUp(e));
        this.textArea.addEventListener('mousedown', () => this.removeExistingOrPendingSuggestion());
        this.textArea.addEventListener('focusout', () => this.removeExistingOrPendingSuggestion());
        // If you scroll, we don't need to kill any pending suggestion request, but we do need to hide
        // any suggestion that's already visible because the fake cursor will now be in the wrong place
        this.textArea.addEventListener('scroll', () => this.suggestionDisplay.reject(), { passive: true });
    }
    handleKeyDown(event) {
        switch (event.key) {
            case 'Tab':
                if (this.suggestionDisplay.isShowing()) {
                    this.suggestionDisplay.accept();
                    event.preventDefault();
                }
                break;
            case 'Alt':
            case 'Control':
            case 'Shift':
            case 'Command':
                break;
            default:
                const keyMatchesExistingSuggestion = this.suggestionDisplay.isShowing()
                    && this.suggestionDisplay.currentSuggestion.startsWith(event.key);
                if (keyMatchesExistingSuggestion) {
                    // Let the typing happen, but without side-effects like removing the existing selection
                    insertTextAtCaretPosition(this.textArea, event.key);
                    event.preventDefault();
                    // Update the existing suggestion to match the new text
                    this.suggestionDisplay.show(this.suggestionDisplay.currentSuggestion.substring(event.key.length));
                    scrollTextAreaDownToCaretIfNeeded(this.textArea);
                }
                else {
                    this.removeExistingOrPendingSuggestion();
                }
                break;
        }
    }
    keyMatchesExistingSuggestion(key) {
        return;
    }
    // If this was changed to a 'keypress' event instead, we'd only initiate suggestions after
    // the user types a visible character, not pressing another key (e.g., arrows, or ctrl+c).
    // However for now I think it is desirable to show suggestions after cursor movement.
    handleKeyUp(event) {
        // If a suggestion is already visible, it must match the current keystroke or it would
        // already have been removed during keydown. So we only start the timeout process if
        // there's no visible suggestion.
        if (!this.suggestionDisplay.isShowing()) {
            clearTimeout(this.typingDebounceTimeout);
            this.typingDebounceTimeout = setTimeout(() => this.handleTypingPaused(), 350);
        }
    }
    handleTypingPaused() {
        if (document.activeElement !== this.textArea) {
            return;
        }
        // We only show a suggestion if the cursor is at the end of the current line. Inserting suggestions in
        // the middle of a line is confusing (things move around in unusual ways).
        // TODO: You could also allow the case where all remaining text on the current line is whitespace
        const isAtEndOfCurrentLine = this.textArea.selectionStart === this.textArea.selectionEnd
            && (this.textArea.selectionStart === this.textArea.value.length || this.textArea.value[this.textArea.selectionStart] === '\n');
        if (!isAtEndOfCurrentLine) {
            return;
        }
        this.requestSuggestionAsync();
    }
    removeExistingOrPendingSuggestion() {
        var _a;
        clearTimeout(this.typingDebounceTimeout);
        (_a = this.pendingSuggestionAbortController) === null || _a === void 0 ? void 0 : _a.abort();
        this.pendingSuggestionAbortController = null;
        this.suggestionDisplay.reject();
    }
    async requestSuggestionAsync() {
        var _a;
        (_a = this.pendingSuggestionAbortController) === null || _a === void 0 ? void 0 : _a.abort();
        this.pendingSuggestionAbortController = new AbortController();
        const snapshot = {
            abortSignal: this.pendingSuggestionAbortController.signal,
            textAreaValue: this.textArea.value,
            cursorPosition: this.textArea.selectionStart,
        };
        const body = {
            // TODO: Limit the amount of text we send, e.g., to 100 characters before and after the cursor
            textBefore: snapshot.textAreaValue.substring(0, snapshot.cursorPosition),
            textAfter: snapshot.textAreaValue.substring(snapshot.cursorPosition),
            config: this.getAttribute('data-config'),
        };
        const antiforgeryName = this.getAttribute('data-antiforgery-name');
        if (antiforgeryName) {
            body[antiforgeryName] = this.getAttribute('data-antiforgery-value');
        }
        const requestInit = {
            method: 'post',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body),
            signal: snapshot.abortSignal,
        };
        let suggestionText;
        try {
            // We rely on the URL being pathbase-relative for Blazor, or a ~/... URL that would already
            // be resolved on the server for MVC
            const httpResponse = await fetch(this.getAttribute('data-url'), requestInit);
            suggestionText = httpResponse.ok ? await httpResponse.text() : null;
        }
        catch (ex) {
            if (ex instanceof DOMException && ex.name === 'AbortError') {
                return;
            }
        }
        // Normally if the user has made further edits in the textarea, our HTTP request would already
        // have been aborted so we wouldn't get here. But if something else (e.g., some other JS code)
        // mutates the textarea, we would still get here. It's important we don't apply the suggestion
        // if the textarea value or cursor position has changed, so compare against our snapshot.
        if (suggestionText
            && snapshot.textAreaValue === this.textArea.value
            && snapshot.cursorPosition === this.textArea.selectionStart) {
            if (!suggestionText.endsWith(' ')) {
                suggestionText += ' ';
            }
            this.suggestionDisplay.show(suggestionText);
        }
    }
}
function shouldUseInlineSuggestions(textArea) {
    // Allow the developer to specify this explicitly if they want
    const explicitConfig = textArea.getAttribute('data-inline-suggestions');
    if (explicitConfig) {
        return explicitConfig.toLowerCase() === 'true';
    }
    // ... but by default, we use overlay on touch devices, inline on non-touch devices
    // That's because:
    //  - Mobile devices will be touch, and most mobile users don't have a "tab" key by which to accept inline suggestions
    //  - Mobile devices such as iOS will display all kinds of extra UI around selected text (e.g., selection handles),
    //    which would look completely wrong
    // In general, the overlay approach is the risk-averse one that works everywhere, even though it's not as attractive.
    const isTouch = 'ontouchstart' in window; // True for any mobile. Usually not true for desktop.
    return !isTouch;
}

// Only run this script once. If you import it multiple times, the 2nd-and-later are no-ops.
const isLoadedMarker = '__smart_components_loaded__';
if (!Object.getOwnPropertyDescriptor(document, isLoadedMarker)) {
    Object.defineProperty(document, isLoadedMarker, { enumerable: false, writable: false });
    registerSmartComboBoxCustomElement();
    registerSmartPasteClickHandler();
    registerSmartTextAreaCustomElement();
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU21hcnRDb21wb25lbnRzLlN0YXRpY0Fzc2V0cy5saWIubW9kdWxlLmpzIiwic291cmNlcyI6WyIuLi90eXBlc2NyaXB0L0Zvcm1VdGlsLnRzIiwiLi4vdHlwZXNjcmlwdC9TbWFydENvbWJvQm94LnRzIiwiLi4vdHlwZXNjcmlwdC9TbWFydFBhc3RlLnRzIiwiLi4vbm9kZV9tb2R1bGVzL2NhcmV0LXBvcy9saWIvZXNtMjAxNS9tYWluLmpzIiwiLi4vdHlwZXNjcmlwdC9TbWFydFRleHRBcmVhL0NhcmV0VXRpbC50cyIsIi4uL3R5cGVzY3JpcHQvU21hcnRUZXh0QXJlYS9JbmxpbmVTdWdnZXN0aW9uRGlzcGxheS50cyIsIi4uL3R5cGVzY3JpcHQvU21hcnRUZXh0QXJlYS9PdmVybGF5U3VnZ2VzdGlvbkRpc3BsYXkudHMiLCIuLi90eXBlc2NyaXB0L1NtYXJ0VGV4dEFyZWEvU21hcnRUZXh0QXJlYS50cyIsIi4uL3R5cGVzY3JpcHQvbWFpbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJleHBvcnQgZnVuY3Rpb24gc2V0Rm9ybUVsZW1lbnRWYWx1ZVdpdGhFdmVudHMoZWxlbTogSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudCwgdmFsdWU6IHN0cmluZyB8IGJvb2xlYW4pIHtcclxuICAgIGlmIChlbGVtIGluc3RhbmNlb2YgSFRNTFNlbGVjdEVsZW1lbnQpIHtcclxuICAgICAgICBjb25zdCB2YWx1ZVRvU3RyaW5nID0gdmFsdWUudG9TdHJpbmcoKTtcclxuICAgICAgICBjb25zdCBuZXdTZWxlY3RlZEluZGV4ID0gZmluZFNlbGVjdE9wdGlvbkJ5VGV4dChlbGVtLCB2YWx1ZVRvU3RyaW5nKTtcclxuICAgICAgICBpZiAobmV3U2VsZWN0ZWRJbmRleCAhPT0gbnVsbCAmJiBlbGVtLnNlbGVjdGVkSW5kZXggIT09IG5ld1NlbGVjdGVkSW5kZXgpIHtcclxuICAgICAgICAgICAgbm90aWZ5Rm9ybUVsZW1lbnRCZWZvcmVXcml0dGVuKGVsZW0pO1xyXG4gICAgICAgICAgICBlbGVtLnNlbGVjdGVkSW5kZXggPSBuZXdTZWxlY3RlZEluZGV4O1xyXG4gICAgICAgICAgICBub3RpZnlGb3JtRWxlbWVudFdyaXR0ZW4oZWxlbSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChlbGVtIGluc3RhbmNlb2YgSFRNTElucHV0RWxlbWVudCAmJiAoZWxlbS50eXBlID09PSAncmFkaW8nIHx8IGVsZW0udHlwZSA9PT0gJ2NoZWNrYm94JykpIHtcclxuICAgICAgICBjb25zdCB2YWx1ZVN0cmluZ0xvd2VyID0gdmFsdWU/LnRvU3RyaW5nKCkudG9Mb3dlckNhc2UoKTtcclxuICAgICAgICBjb25zdCBzaG91bGRDaGVjayA9ICh2YWx1ZVN0cmluZ0xvd2VyID09PSBcInRydWVcIikgfHwgKHZhbHVlU3RyaW5nTG93ZXIgPT09IFwieWVzXCIpIHx8ICh2YWx1ZVN0cmluZ0xvd2VyID09PSBcIm9uXCIpO1xyXG4gICAgICAgIGlmIChlbGVtICYmIGVsZW0uY2hlY2tlZCAhPT0gc2hvdWxkQ2hlY2spIHtcclxuICAgICAgICAgICAgbm90aWZ5Rm9ybUVsZW1lbnRCZWZvcmVXcml0dGVuKGVsZW0pO1xyXG4gICAgICAgICAgICBlbGVtLmNoZWNrZWQgPSBzaG91bGRDaGVjaztcclxuICAgICAgICAgICAgbm90aWZ5Rm9ybUVsZW1lbnRXcml0dGVuKGVsZW0pO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgaWYgKGlzQ29tYm9Cb3goZWxlbSkpIHtcclxuICAgICAgICAgICAgLy8gVE9ETzogU3VwcG9ydCBkYXRhbGlzdCBieSBpbnRlcnByZXRpbmcgaXQgYXMgYSBzZXQgb2YgYWxsb3dlZCB2YWx1ZXMuIFdoZW4gcG9wdWxhdGluZ1xyXG4gICAgICAgICAgICAvLyB0aGUgZm9ybSwgb25seSBhY2NlcHQgc3VnZ2VzdGlvbnMgdGhhdCBtYXRjaCBvbmUgb2YgdGhlIGFsbG93ZWQgdmFsdWVzLlxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB2YWx1ZSA9IHZhbHVlLnRvU3RyaW5nKCk7XHJcbiAgICAgICAgaWYgKGVsZW0udmFsdWUgIT09IHZhbHVlKSB7XHJcbiAgICAgICAgICAgIG5vdGlmeUZvcm1FbGVtZW50QmVmb3JlV3JpdHRlbihlbGVtKTtcclxuICAgICAgICAgICAgZWxlbS52YWx1ZSA9IHZhbHVlO1xyXG4gICAgICAgICAgICBub3RpZnlGb3JtRWxlbWVudFdyaXR0ZW4oZWxlbSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNDb21ib0JveChlbGVtKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gISEoZWxlbS5saXN0IHx8IGVsZW0uZ2V0QXR0cmlidXRlKCdkYXRhLWF1dG9jb21wbGV0ZScpKTtcclxufVxyXG5cclxuLy8gQ2xpZW50LXNpZGUgY29kZSAoZS5nLiwgdmFsaWRhdGlvbikgbWF5IHJlYWN0IHdoZW4gYW4gZWxlbWVudCB2YWx1ZSBpcyBjaGFuZ2VkXHJcbi8vIFdlJ2xsIHRyaWdnZXIgdGhlIHNhbWUga2luZHMgb2YgZXZlbnRzIHRoYXQgZmlyZSBpZiB5b3UgdHlwZVxyXG5mdW5jdGlvbiBub3RpZnlGb3JtRWxlbWVudEJlZm9yZVdyaXR0ZW4oZWxlbTogSFRNTEVsZW1lbnQpIHtcclxuICAgIGVsZW0uZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ2JlZm9yZWlucHV0JywgeyBidWJibGVzOiB0cnVlLCBkZXRhaWw6IHsgZnJvbVNtYXJ0Q29tcG9uZW50czogdHJ1ZSB9IH0pKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm90aWZ5Rm9ybUVsZW1lbnRXcml0dGVuKGVsZW06IEhUTUxFbGVtZW50KSB7XHJcbiAgICBlbGVtLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSwgZGV0YWlsOiB7IGZyb21TbWFydENvbXBvbmVudHM6IHRydWUgfSB9KSk7XHJcbiAgICBlbGVtLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCdjaGFuZ2UnLCB7IGJ1YmJsZXM6IHRydWUsIGRldGFpbDogeyBmcm9tU21hcnRDb21wb25lbnRzOiB0cnVlIH0gfSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kU2VsZWN0T3B0aW9uQnlUZXh0KHNlbGVjdEVsZW06IEhUTUxTZWxlY3RFbGVtZW50LCB2YWx1ZVRleHQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xyXG4gICAgY29uc3Qgb3B0aW9ucyA9IEFycmF5LmZyb20oc2VsZWN0RWxlbS5xdWVyeVNlbGVjdG9yQWxsKCdvcHRpb24nKSk7XHJcbiAgICBjb25zdCBleGFjdE1hdGNoZXMgPSBvcHRpb25zLmZpbHRlcihvID0+IG8udGV4dENvbnRlbnQgPT09IHZhbHVlVGV4dCk7XHJcbiAgICBpZiAoZXhhY3RNYXRjaGVzLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gb3B0aW9ucy5pbmRleE9mKGV4YWN0TWF0Y2hlc1swXSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgcGFydGlhbE1hdGNoZXMgPSBvcHRpb25zLmZpbHRlcihvID0+IG8udGV4dENvbnRlbnQgJiYgby50ZXh0Q29udGVudC5pbmRleE9mKHZhbHVlVGV4dCkgPj0gMCk7XHJcbiAgICBpZiAocGFydGlhbE1hdGNoZXMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgcmV0dXJuIG9wdGlvbnMuaW5kZXhPZihwYXJ0aWFsTWF0Y2hlc1swXSk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuIiwiaW1wb3J0IHsgc2V0Rm9ybUVsZW1lbnRWYWx1ZVdpdGhFdmVudHMgfSBmcm9tICcuL0Zvcm1VdGlsJztcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNtYXJ0Q29tYm9Cb3hDdXN0b21FbGVtZW50KCkge1xyXG4gICAgY3VzdG9tRWxlbWVudHMuZGVmaW5lKCdzbWFydC1jb21ib2JveCcsIFNtYXJ0Q29tYm9Cb3gpO1xyXG59XHJcblxyXG5jbGFzcyBTbWFydENvbWJvQm94IGV4dGVuZHMgSFRNTEVsZW1lbnQge1xyXG4gICAgaW5wdXRFbGVtOiBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgcmVxdWVzdFN1Z2dlc3Rpb25zVGltZW91dCA9IDA7XHJcbiAgICBkZWJvdW5jZUtleXN0cm9rZXNEZWxheSA9IDI1MDtcclxuICAgIGN1cnJlbnRBYm9ydENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG4gICAgc2VsZWN0ZWRJbmRleCA9IDA7XHJcbiAgICBzdGF0aWMgbmV4dFN1Z2dlc3Rpb25zRWxlbUlkID0gMDtcclxuXHJcbiAgICBjb25uZWN0ZWRDYWxsYmFjaygpIHtcclxuICAgICAgICB0aGlzLmlucHV0RWxlbSA9IHRoaXMucHJldmlvdXNFbGVtZW50U2libGluZyBhcyBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgICAgIGlmICghKHRoaXMuaW5wdXRFbGVtIGluc3RhbmNlb2YgSFRNTElucHV0RWxlbWVudCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdzbWFydC1jb21ib2JveCBtdXN0IGJlIHBsYWNlZCBpbW1lZGlhdGVseSBhZnRlciBhbiBpbnB1dCBlbGVtZW50Jyk7XHJcbiAgICAgICAgfVxyXG4gXHJcbiAgICAgICAgdGhpcy5pZCA9IGBzbWFydGNvbWJvYm94LXN1Z2dlc3Rpb25zLSR7U21hcnRDb21ib0JveC5uZXh0U3VnZ2VzdGlvbnNFbGVtSWQrK31gO1xyXG4gICAgICAgIHRoaXMuY2xhc3NMaXN0LmFkZCgnc21hcnRjb21ib2JveC1zdWdnZXN0aW9ucycpO1xyXG4gICAgICAgIHRoaXMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vkb3duJywgZXZlbnQgPT4ge1xyXG4gICAgICAgICAgICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsYXNzTGlzdC5jb250YWlucygnc21hcnRjb21ib2JveC1zdWdnZXN0aW9uJykpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuX2hhbmRsZVN1Z2dlc3Rpb25TZWxlY3RlZChldmVudC50YXJnZXQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHRoaXMuaW5wdXRFbGVtLnNldEF0dHJpYnV0ZSgnYXJpYS1jb250cm9scycsIHRoaXMuaWQpO1xyXG4gICAgICAgIHRoaXMuX3NldFN1Z2dlc3Rpb25zKFtdKTtcclxuXHJcbiAgICAgICAgdGhpcy5pbnB1dEVsZW0uYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGV2ZW50ID0+IHtcclxuICAgICAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0Fycm93VXAnKSB7XHJcbiAgICAgICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU2VsZWN0aW9uKHsgb2Zmc2V0OiAtMSwgdXBkYXRlSW5wdXRUb01hdGNoOiB0cnVlIH0pO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gJ0Fycm93RG93bicpIHtcclxuICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTZWxlY3Rpb24oeyBvZmZzZXQ6IDEsIHVwZGF0ZUlucHV0VG9NYXRjaDogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFbnRlcicpIHtcclxuICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzdWdnZXN0aW9uID0gdGhpcy5jaGlsZHJlblt0aGlzLnNlbGVjdGVkSW5kZXhdIGFzIEhUTUxFbGVtZW50O1xyXG4gICAgICAgICAgICAgICAgaWYgKHN1Z2dlc3Rpb24pIHtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9oYW5kbGVTdWdnZXN0aW9uU2VsZWN0ZWQoc3VnZ2VzdGlvbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgdGhpcy5pbnB1dEVsZW0uYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBldmVudCA9PiB7XHJcbiAgICAgICAgICAgIGlmIChldmVudCBpbnN0YW5jZW9mIEN1c3RvbUV2ZW50ICYmIGV2ZW50LmRldGFpbC5mcm9tU21hcnRDb21wb25lbnRzKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47IC8vIFdoZW4gd2UgdHJpZ2dlcmVkIHRoZSB1cGRhdGUgcHJvZ3JhbW1hdGljYWxseSwgdGhhdCdzIG5vdCBhIHJlYXNvbiB0byBmZXRjaCBtb3JlIHN1Z2dlc3Rpb25zXHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aGlzLnJlcXVlc3RTdWdnZXN0aW9uc1RpbWVvdXQpO1xyXG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRBYm9ydENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICAgICAgICAgIHRoaXMuY3VycmVudEFib3J0Q29udHJvbGxlciA9IG51bGw7XHJcblxyXG4gICAgICAgICAgICBpZiAodGhpcy5pbnB1dEVsZW0udmFsdWUgPT09ICcnKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLl9zZXRTdWdnZXN0aW9ucyhbXSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnJlcXVlc3RTdWdnZXN0aW9uc1RpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZXF1ZXN0U3VnZ2VzdGlvbnMoKTtcclxuICAgICAgICAgICAgICAgIH0sIHRoaXMuZGVib3VuY2VLZXlzdHJva2VzRGVsYXkpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHRoaXMuaW5wdXRFbGVtLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4gdGhpcy5fdXBkYXRlQXJpYVN0YXRlcygpKTtcclxuICAgICAgICB0aGlzLmlucHV0RWxlbS5hZGRFdmVudExpc3RlbmVyKCdibHVyJywgKCkgPT4gdGhpcy5fdXBkYXRlQXJpYVN0YXRlcygpKTtcclxuICAgIH1cclxuXHJcbiAgICBhc3luYyBfcmVxdWVzdFN1Z2dlc3Rpb25zKCkge1xyXG4gICAgICAgIHRoaXMuY3VycmVudEFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuXHJcbiAgICAgICAgY29uc3QgYm9keSA9IHtcclxuICAgICAgICAgICAgaW5wdXRWYWx1ZTogdGhpcy5pbnB1dEVsZW0udmFsdWUsXHJcbiAgICAgICAgICAgIG1heFJlc3VsdHM6IHRoaXMuZ2V0QXR0cmlidXRlKCdkYXRhLW1heC1zdWdnZXN0aW9ucycpLFxyXG4gICAgICAgICAgICBzaW1pbGFyaXR5VGhyZXNob2xkOiB0aGlzLmdldEF0dHJpYnV0ZSgnZGF0YS1zaW1pbGFyaXR5LXRocmVzaG9sZCcpLFxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIGNvbnN0IGFudGlmb3JnZXJ5TmFtZSA9IHRoaXMuZ2V0QXR0cmlidXRlKCdkYXRhLWFudGlmb3JnZXJ5LW5hbWUnKTtcclxuICAgICAgICBpZiAoYW50aWZvcmdlcnlOYW1lKSB7XHJcbiAgICAgICAgICAgIGJvZHlbYW50aWZvcmdlcnlOYW1lXSA9IHRoaXMuZ2V0QXR0cmlidXRlKCdkYXRhLWFudGlmb3JnZXJ5LXZhbHVlJyk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgcmVzcG9uc2U6IFJlc3BvbnNlO1xyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RJbml0OiBSZXF1ZXN0SW5pdCA9IHtcclxuICAgICAgICAgICAgbWV0aG9kOiAncG9zdCcsXHJcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgYm9keTogbmV3IFVSTFNlYXJjaFBhcmFtcyhib2R5KSxcclxuICAgICAgICAgICAgc2lnbmFsOiB0aGlzLmN1cnJlbnRBYm9ydENvbnRyb2xsZXIuc2lnbmFsLFxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIC8vIFdlIHJlbHkgb24gdGhlIFVSTCBiZWluZyBwYXRoYmFzZS1yZWxhdGl2ZSBmb3IgQmxhem9yLCBvciBhIH4vLi4uIFVSTCB0aGF0IHdvdWxkIGFscmVhZHlcclxuICAgICAgICAgICAgLy8gYmUgcmVzb2x2ZWQgb24gdGhlIHNlcnZlciBmb3IgTVZDXHJcbiAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godGhpcy5nZXRBdHRyaWJ1dGUoJ2RhdGEtc3VnZ2VzdGlvbnMtdXJsJyksIHJlcXVlc3RJbml0KTtcclxuICAgICAgICAgICAgY29uc3Qgc3VnZ2VzdGlvbnM6IHN0cmluZ1tdID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xyXG4gICAgICAgICAgICB0aGlzLl9zZXRTdWdnZXN0aW9ucyhzdWdnZXN0aW9ucyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNhdGNoIChleCkge1xyXG4gICAgICAgICAgICBpZiAoZXggaW5zdGFuY2VvZiBET01FeGNlcHRpb24gJiYgZXgubmFtZSA9PT0gJ0Fib3J0RXJyb3InKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIHRocm93IGV4O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBfc2V0U3VnZ2VzdGlvbnMoc3VnZ2VzdGlvbnM6IHN0cmluZ1tdKSB7XHJcbiAgICAgICAgd2hpbGUgKHRoaXMuZmlyc3RFbGVtZW50Q2hpbGQpIHtcclxuICAgICAgICAgICAgdGhpcy5maXJzdEVsZW1lbnRDaGlsZC5yZW1vdmUoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxldCBvcHRpb25JbmRleCA9IDA7XHJcbiAgICAgICAgc3VnZ2VzdGlvbnMuZm9yRWFjaChjaG9pY2UgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICAgICAgb3B0aW9uLmlkID0gYCR7dGhpcy5pZH1faXRlbSR7b3B0aW9uSW5kZXgrK31gO1xyXG4gICAgICAgICAgICBvcHRpb24uc2V0QXR0cmlidXRlKCdyb2xlJywgJ29wdGlvbicpO1xyXG4gICAgICAgICAgICBvcHRpb24uc2V0QXR0cmlidXRlKCdhcmlhLXNlbGVjdGVkJywgJ2ZhbHNlJyk7XHJcbiAgICAgICAgICAgIG9wdGlvbi5jbGFzc0xpc3QuYWRkKCdzbWFydGNvbWJvYm94LXN1Z2dlc3Rpb24nKTtcclxuICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gY2hvaWNlO1xyXG4gICAgICAgICAgICB0aGlzLmFwcGVuZENoaWxkKG9wdGlvbik7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGlmIChzdWdnZXN0aW9ucy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU2VsZWN0aW9uKHsgc3VnZ2VzdGlvbjogdGhpcy5jaGlsZHJlblswXSBhcyBIVE1MRWxlbWVudCB9KTtcclxuICAgICAgICAgICAgdGhpcy5zdHlsZS5kaXNwbGF5ID0gbnVsbDsgLy8gQWxsb3cgdmlzaWJpbGl0eSB0byBiZSBjb250cm9sbGVkIGJ5IGZvY3VzIHJ1bGUgaW4gQ1NTXHJcblxyXG4gICAgICAgICAgICAvLyBXZSByZWx5IG9uIHRoZSBpbnB1dCBub3QgbW92aW5nIHJlbGF0aXZlIHRvIGl0cyBvZmZzZXRQYXJlbnQgd2hpbGUgdGhlIHN1Z2dlc3Rpb25zXHJcbiAgICAgICAgICAgIC8vIGFyZSB2aXNpYmxlLiBEZXZlbG9wZXJzIGNhbiBhbHdheXMgcHV0IHRoZSBpbnB1dCBkaXJlY3RseSBpbnNpZGUgYSByZWxhdGl2ZWx5LXBvc2l0aW9uZWRcclxuICAgICAgICAgICAgLy8gY29udGFpbmVyIGlmIHRoZXkgbmVlZCB0aGlzIHRvIHdvcmsgb24gYSBmaW5lLWdyYWluZWQgYmFzaXMuXHJcbiAgICAgICAgICAgIHRoaXMuc3R5bGUudG9wID0gdGhpcy5pbnB1dEVsZW0ub2Zmc2V0VG9wICsgdGhpcy5pbnB1dEVsZW0ub2Zmc2V0SGVpZ2h0ICsgJ3B4JztcclxuICAgICAgICAgICAgdGhpcy5zdHlsZS5sZWZ0ID0gdGhpcy5pbnB1dEVsZW0ub2Zmc2V0TGVmdCArICdweCc7XHJcbiAgICAgICAgICAgIHRoaXMuc3R5bGUud2lkdGggPSB0aGlzLmlucHV0RWxlbS5vZmZzZXRXaWR0aCArICdweCc7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdGhpcy5fdXBkYXRlQXJpYVN0YXRlcygpO1xyXG4gICAgfVxyXG5cclxuICAgIF91cGRhdGVBcmlhU3RhdGVzKCkge1xyXG4gICAgICAgIC8vIGFyaWEtZXhwYW5kZWRcclxuICAgICAgICBjb25zdCBpc0V4cGFuZGVkID0gdGhpcy5maXJzdENoaWxkICYmIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgPT09IHRoaXMuaW5wdXRFbGVtO1xyXG4gICAgICAgIHRoaXMuaW5wdXRFbGVtLnNldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsIGlzRXhwYW5kZWQgPyAndHJ1ZScgOiAnZmFsc2UnKTtcclxuXHJcbiAgICAgICAgLy8gYXJpYS1hY3RpdmVkZXNjZW5kYW50XHJcbiAgICAgICAgY29uc3Qgc3VnZ2VzdGlvbiA9IGlzRXhwYW5kZWQgJiYgdGhpcy5jaGlsZHJlblt0aGlzLnNlbGVjdGVkSW5kZXhdIGFzIEhUTUxFbGVtZW50O1xyXG4gICAgICAgIGlmICghc3VnZ2VzdGlvbikge1xyXG4gICAgICAgICAgICB0aGlzLmlucHV0RWxlbS5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYWN0aXZlZGVzY2VuZGFudCcpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRoaXMuaW5wdXRFbGVtLnNldEF0dHJpYnV0ZSgnYXJpYS1hY3RpdmVkZXNjZW5kYW50Jywgc3VnZ2VzdGlvbi5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIF9oYW5kbGVTdWdnZXN0aW9uU2VsZWN0ZWQoc3VnZ2VzdGlvbjogSFRNTEVsZW1lbnQpIHtcclxuICAgICAgICB0aGlzLl91cGRhdGVTZWxlY3Rpb24oeyBzdWdnZXN0aW9uLCB1cGRhdGVJbnB1dFRvTWF0Y2g6IHRydWUgfSk7XHJcbiAgICAgICAgdGhpcy5pbnB1dEVsZW0uYmx1cigpO1xyXG4gICAgfVxyXG5cclxuICAgIF91cGRhdGVTZWxlY3Rpb24ob3BlcmF0aW9uOiB7IG9mZnNldD86IG51bWJlciwgc3VnZ2VzdGlvbj86IEhUTUxFbGVtZW50LCB1cGRhdGVJbnB1dFRvTWF0Y2g/OiBib29sZWFuIH0pIHtcclxuICAgICAgICBsZXQgc3VnZ2VzdGlvbiA9IG9wZXJhdGlvbi5zdWdnZXN0aW9uO1xyXG4gICAgICAgIGlmIChzdWdnZXN0aW9uKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRJbmRleCA9IEFycmF5LmZyb20odGhpcy5jaGlsZHJlbikuaW5kZXhPZihzdWdnZXN0aW9uKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBpZiAoaXNOYU4ob3BlcmF0aW9uLm9mZnNldCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3VwcGx5IGVpdGhlciBvZmZzZXQgb3Igc2VsZWN0aW9uIGVsZW1lbnQnKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY29uc3QgbmV3SW5kZXggPSBNYXRoLm1heCgwLCBNYXRoLm1pbih0aGlzLmNoaWxkcmVuLmxlbmd0aCAtIDEsIHRoaXMuc2VsZWN0ZWRJbmRleCArIG9wZXJhdGlvbi5vZmZzZXQpKTtcclxuICAgICAgICAgICAgaWYgKG5ld0luZGV4ID09PSB0aGlzLnNlbGVjdGVkSW5kZXgpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgdGhpcy5zZWxlY3RlZEluZGV4ID0gbmV3SW5kZXg7XHJcbiAgICAgICAgICAgIHN1Z2dlc3Rpb24gPSB0aGlzLmNoaWxkcmVuW25ld0luZGV4XSBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHByZXZTZWxlY3RlZFN1Z2dlc3Rpb24gPSB0aGlzLnF1ZXJ5U2VsZWN0b3IoJy5zZWxlY3RlZCcpO1xyXG4gICAgICAgIGlmIChwcmV2U2VsZWN0ZWRTdWdnZXN0aW9uID09PSBzdWdnZXN0aW9uICYmIHRoaXMuaW5wdXRFbGVtLnZhbHVlID09PSBzdWdnZXN0aW9uLnRleHRDb250ZW50KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHByZXZTZWxlY3RlZFN1Z2dlc3Rpb24/LnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsICdmYWxzZScpO1xyXG4gICAgICAgIHByZXZTZWxlY3RlZFN1Z2dlc3Rpb24/LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbGVjdGVkJyk7XHJcbiAgICAgICAgc3VnZ2VzdGlvbi5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLCAndHJ1ZScpO1xyXG4gICAgICAgIHN1Z2dlc3Rpb24uY2xhc3NMaXN0LmFkZCgnc2VsZWN0ZWQnKTtcclxuXHJcbiAgICAgICAgaWYgKHN1Z2dlc3Rpb25bJ3Njcm9sbEludG9WaWV3SWZOZWVkZWQnXSkge1xyXG4gICAgICAgICAgICBzdWdnZXN0aW9uWydzY3JvbGxJbnRvVmlld0lmTmVlZGVkJ10oZmFsc2UpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIC8vIEZpcmVmb3ggZG9lc24ndCBzdXBwb3J0IHNjcm9sbEludG9WaWV3SWZOZWVkZWQsIHNvIHdlIGZhbGwgYmFjayBvbiBzY3JvbGxJbnRvVmlldy5cclxuICAgICAgICAgICAgLy8gVGhpcyB3aWxsIGFsaWduIHRoZSB0b3Agb2YgdGhlIHN1Z2dlc3Rpb24gd2l0aCB0aGUgdG9wIG9mIHRoZSBzY3JvbGxhYmxlIGFyZWEuXHJcbiAgICAgICAgICAgIHN1Z2dlc3Rpb24uc2Nyb2xsSW50b1ZpZXcoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMuX3VwZGF0ZUFyaWFTdGF0ZXMoKTtcclxuXHJcbiAgICAgICAgaWYgKG9wZXJhdGlvbi51cGRhdGVJbnB1dFRvTWF0Y2gpIHtcclxuICAgICAgICAgICAgc2V0Rm9ybUVsZW1lbnRWYWx1ZVdpdGhFdmVudHModGhpcy5pbnB1dEVsZW0sIHN1Z2dlc3Rpb24udGV4dENvbnRlbnQgfHwgJycpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG4iLCJpbXBvcnQgeyBpc0NvbWJvQm94LCBzZXRGb3JtRWxlbWVudFZhbHVlV2l0aEV2ZW50cyB9IGZyb20gJy4vRm9ybVV0aWwnO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU21hcnRQYXN0ZUNsaWNrSGFuZGxlcigpIHtcclxuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2dCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2dC50YXJnZXQ7XHJcbiAgICAgICAgaWYgKHRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gdGFyZ2V0LmNsb3Nlc3QoJ2J1dHRvbltkYXRhLXNtYXJ0LXBhc3RlLXRyaWdnZXI9dHJ1ZV0nKTtcclxuICAgICAgICAgICAgaWYgKGJ1dHRvbiBpbnN0YW5jZW9mIEhUTUxCdXR0b25FbGVtZW50KSB7XHJcbiAgICAgICAgICAgICAgICBwZXJmb3JtU21hcnRQYXN0ZShidXR0b24pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1TbWFydFBhc3RlKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpIHtcclxuICAgIGNvbnN0IGZvcm0gPSBidXR0b24uY2xvc2VzdCgnZm9ybScpO1xyXG4gICAgaWYgKCFmb3JtKSB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcignQSBzbWFydCBwYXN0ZSBidXR0b24gd2FzIGNsaWNrZWQsIGJ1dCBpdCBpcyBub3QgaW5zaWRlIGEgZm9ybScpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmb3JtQ29uZmlnID0gZXh0cmFjdEZvcm1Db25maWcoZm9ybSk7XHJcbiAgICBpZiAoZm9ybUNvbmZpZy5sZW5ndGggPT0gMCkge1xyXG4gICAgICAgIGNvbnNvbGUud2FybignQSBzbWFydCBwYXN0ZSBidXR0b24gd2FzIGNsaWNrZWQsIGJ1dCBubyBmaWVsZHMgd2VyZSBmb3VuZCBpbiBpdHMgZm9ybScpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBjbGlwYm9hcmRDb250ZW50cyA9IGF3YWl0IHJlYWRDbGlwYm9hcmRUZXh0KCk7XHJcbiAgICBpZiAoIWNsaXBib2FyZENvbnRlbnRzKSB7XHJcbiAgICAgICAgY29uc29sZS5pbmZvKCdBIHNtYXJ0IHBhc3RlIGJ1dHRvbiB3YXMgY2xpY2tlZCwgYnV0IG5vIGRhdGEgd2FzIGZvdW5kIG9uIHRoZSBjbGlwYm9hcmQnKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZ2V0U21hcnRQYXN0ZVJlc3BvbnNlKGJ1dHRvbiwgZm9ybUNvbmZpZywgY2xpcGJvYXJkQ29udGVudHMpO1xyXG4gICAgICAgIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuICAgICAgICBwb3B1bGF0ZUZvcm0oZm9ybSwgZm9ybUNvbmZpZywgcmVzcG9uc2VUZXh0KTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBvcHVsYXRlRm9ybShmb3JtOiBIVE1MRm9ybUVsZW1lbnQsIGZvcm1Db25maWc6IEZpZWxkQ29uZmlnW10sIHJlc3BvbnNlVGV4dDogc3RyaW5nKSB7XHJcbiAgICBjb25zdCByZXN1bHREYXRhID0ge307XHJcbiAgICBjb25zdCBwcmVmaXggPSAnRklFTEQgJztcclxuICAgIGxldCBwcmV2RmllbGRLZXk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gICAgcmVzcG9uc2VUZXh0LnNwbGl0KCdcXG4nKS5mb3JFYWNoKGxpbmUgPT4ge1xyXG4gICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgocHJlZml4KSkge1xyXG4gICAgICAgICAgICBjb25zdCBrZXlWYWx1ZVBhaXIgPSBsaW5lLnN1YnN0cmluZyhwcmVmaXgubGVuZ3RoKS5zcGxpdCgnXl5eJyk7XHJcbiAgICAgICAgICAgIGlmIChrZXlWYWx1ZVBhaXIubGVuZ3RoID09PSAyKSB7XHJcbiAgICAgICAgICAgICAgICByZXN1bHREYXRhW2tleVZhbHVlUGFpclswXV0gPSBrZXlWYWx1ZVBhaXJbMV07XHJcbiAgICAgICAgICAgICAgICBwcmV2RmllbGRLZXkgPSBrZXlWYWx1ZVBhaXJbMF07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHByZXZGaWVsZEtleSkge1xyXG4gICAgICAgICAgICByZXN1bHREYXRhW3ByZXZGaWVsZEtleV0gKz0gJ1xcbicgKyBsaW5lO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGZvcm1Db25maWcuZm9yRWFjaChmaWVsZCA9PiB7XHJcbiAgICAgICAgbGV0IHZhbHVlID0gcmVzdWx0RGF0YVtmaWVsZC5pZGVudGlmaWVyXTtcclxuICAgICAgICBpZiAodmFsdWUgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICB2YWx1ZSA9IHZhbHVlLnRyaW0oKTtcclxuICAgICAgICAgICAgaWYgKHZhbHVlID09PSAnTk9fREFUQScpIHtcclxuICAgICAgICAgICAgICAgIC8vIEl0J3MgdXN1YWxseSBiZXR0ZXIgdG8gbGVhdmUgdGhlIGV4aXN0aW5nIGZpZWxkIGRhdGEgaW4gcGxhY2UsIHNpbmNlIHRoZXJlIG1pZ2h0IGJlIHVzZWZ1bFxyXG4gICAgICAgICAgICAgICAgLy8gdmFsdWVzIGluIHVucmVsYXRlZCBmaWVsZHMuIEl0IHdvdWxkIGJlIG5pY2UgaWYgdGhlIGluZmVyZW5jZSBjb3VsZCBjb25jbHVzaXZlbHkgZGV0ZXJtaW5lXHJcbiAgICAgICAgICAgICAgICAvLyBjYXNlcyB3aGVuIGEgZmllbGQgc2hvdWxkIGJlIGNsZWFyZWQsIGJ1dCBpbiBtb3N0IGNhc2VzIGl0IGNhbid0IGRpc3Rpbmd1aXNoIFwibm8gaW5mb3JtYXRpb25cclxuICAgICAgICAgICAgICAgIC8vIGF2YWlsYWJsZVwiIGZyb20gXCJ0aGUgdmFsdWUgc2hvdWxkIGRlZmluaXRlbHkgYmUgYmxhbmtlZCBvdXRcIi5cclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKGZpZWxkLmVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ICYmIGZpZWxkLmVsZW1lbnQudHlwZSA9PT0gJ3JhZGlvJykge1xyXG4gICAgICAgICAgICAgICAgLy8gUmFkaW8gaXMgYSBiaXQgbW9yZSBjb21wbGV4IHRoYW4gdGhlIG90aGVycyBhcyBpdCdzIG5vdCBqdXN0IGEgc2luZ2xlIGZvcm0gZWxlbWVudFxyXG4gICAgICAgICAgICAgICAgLy8gV2UgaGF2ZSB0byBmaW5kIHRoZSBvbmUgY29ycmVzcG9uZGluZyB0byB0aGUgbmV3IHZhbHVlLCB3aGljaCBpbiB0dXJuIGRlcGVuZHMgb25cclxuICAgICAgICAgICAgICAgIC8vIGhvdyB3ZSdyZSBpbnRlcnByZXRpbmcgdGhlIGZpZWxkIGRlc2NyaXB0aW9uXHJcbiAgICAgICAgICAgICAgICBjb25zdCByYWRpb0lucHV0VG9TZWxlY3QgPSBmaW5kSW5wdXRSYWRpb0J5VGV4dChmb3JtLCBmaWVsZC5lbGVtZW50Lm5hbWUsIHZhbHVlKTtcclxuICAgICAgICAgICAgICAgIGlmIChyYWRpb0lucHV0VG9TZWxlY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRGb3JtRWxlbWVudFZhbHVlV2l0aEV2ZW50cyhyYWRpb0lucHV0VG9TZWxlY3QsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0Rm9ybUVsZW1lbnRWYWx1ZVdpdGhFdmVudHMoZmllbGQuZWxlbWVudCwgdmFsdWUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRJbnB1dFJhZGlvQnlUZXh0KGZvcm06IEhUTUxGb3JtRWxlbWVudCwgcmFkaW9Hcm91cE5hbWU6IHN0cmluZywgdmFsdWVUZXh0OiBzdHJpbmcpOiBIVE1MSW5wdXRFbGVtZW50IHwgbnVsbCB7XHJcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gQXJyYXkuZnJvbShmb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0W3R5cGU9cmFkaW9dJykpXHJcbiAgICAgICAgLmZpbHRlcihlID0+IGUgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ICYmIGUubmFtZSA9PT0gcmFkaW9Hcm91cE5hbWUpXHJcbiAgICAgICAgLm1hcChlID0+ICh7IGVsZW06IGUgYXMgSFRNTElucHV0RWxlbWVudCwgdGV4dDogaW5mZXJGaWVsZERlc2NyaXB0aW9uKGZvcm0sIGUgYXMgSFRNTElucHV0RWxlbWVudCkgfSkpO1xyXG4gICAgY29uc3QgZXhhY3RNYXRjaGVzID0gY2FuZGlkYXRlcy5maWx0ZXIobyA9PiBvLnRleHQgPT09IHZhbHVlVGV4dCk7XHJcbiAgICBpZiAoZXhhY3RNYXRjaGVzLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gZXhhY3RNYXRjaGVzWzBdLmVsZW07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgcGFydGlhbE1hdGNoZXMgPSBjYW5kaWRhdGVzLmZpbHRlcihvID0+IG8udGV4dCAmJiBvLnRleHQuaW5kZXhPZih2YWx1ZVRleHQpID49IDApO1xyXG4gICAgaWYgKHBhcnRpYWxNYXRjaGVzLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgIHJldHVybiBwYXJ0aWFsTWF0Y2hlc1swXS5lbGVtO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQ2xpcGJvYXJkVGV4dCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcclxuICAgIGNvbnN0IGZha2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZmFrZS1jbGlwYm9hcmQnKSBhcyBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgaWYgKGZha2U/LnZhbHVlKSB7XHJcbiAgICAgICAgcmV0dXJuIGZha2UudmFsdWU7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFuYXZpZ2F0b3IuY2xpcGJvYXJkLnJlYWRUZXh0KSB7XHJcbiAgICAgICAgYWxlcnQoJ1RoZSBjdXJyZW50IGJyb3dzZXIgZG9lcyBub3Qgc3VwcG9ydCByZWFkaW5nIHRoZSBjbGlwYm9hcmQuXFxuXFxuVE9ETzogSW1wbGVtZW50IGFsdGVybmF0ZSBVSSBmb3IgdGhpcyBjYXNlLicpO1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBuYXZpZ2F0b3IuY2xpcGJvYXJkLnJlYWRUZXh0KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4dHJhY3RGb3JtQ29uZmlnKGZvcm06IEhUTUxGb3JtRWxlbWVudCk6IEZpZWxkQ29uZmlnW10ge1xyXG4gICAgY29uc3QgZmllbGRzOiBGaWVsZENvbmZpZ1tdID0gW107XHJcbiAgICBsZXQgdW5pZGVudGlmaWVkQ291bnQgPSAwO1xyXG4gICAgZm9ybS5xdWVyeVNlbGVjdG9yQWxsKCdpbnB1dCwgc2VsZWN0LCB0ZXh0YXJlYScpLmZvckVhY2goZWxlbWVudCA9PiB7XHJcbiAgICAgICAgaWYgKCEoZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxJbnB1dEVsZW1lbnQgfHwgZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxTZWxlY3RFbGVtZW50IHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50KSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoZWxlbWVudC50eXBlID09PSAnaGlkZGVuJyB8fCBpc0NvbWJvQm94KGVsZW1lbnQpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IGlzUmFkaW8gPSBlbGVtZW50LnR5cGUgPT09ICdyYWRpbyc7XHJcbiAgICAgICAgY29uc3QgaWRlbnRpZmllciA9IGlzUmFkaW9cclxuICAgICAgICAgICAgPyBlbGVtZW50Lm5hbWVcclxuICAgICAgICAgICAgOiBlbGVtZW50LmlkIHx8IGVsZW1lbnQubmFtZSB8fCBgdW5pZGVudGlmaWVkXyR7Kyt1bmlkZW50aWZpZWRDb3VudH1gO1xyXG5cclxuICAgICAgICAvLyBPbmx5IGluY2x1ZGUgb25lIGZpZWxkIGZvciBlYWNoIHJlbGF0ZWQgc2V0IG9mIHJhZGlvIGJ1dHRvbnNcclxuICAgICAgICBpZiAoaXNSYWRpbyAmJiBmaWVsZHMuZmluZChmID0+IGYuaWRlbnRpZmllciA9PT0gaWRlbnRpZmllcikpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGRlc2NyaXB0aW9uOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICAgICAgICBpZiAoIWlzUmFkaW8pIHtcclxuICAgICAgICAgICAgZGVzY3JpcHRpb24gPSBpbmZlckZpZWxkRGVzY3JpcHRpb24oZm9ybSwgZWxlbWVudCk7XHJcbiAgICAgICAgICAgIGlmICghZGVzY3JpcHRpb24pIHtcclxuICAgICAgICAgICAgICAgIC8vIElmIHdlIGNhbid0IHNheSBhbnl0aGluZyBhYm91dCB3aGF0IHRoaXMgZmllbGQgcmVwcmVzZW50cywgd2UgaGF2ZSB0byBleGNsdWRlIGl0XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IGZpZWxkRW50cnk6IEZpZWxkQ29uZmlnID0ge1xyXG4gICAgICAgICAgICBpZGVudGlmaWVyOiBpZGVudGlmaWVyLFxyXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogZGVzY3JpcHRpb24sXHJcbiAgICAgICAgICAgIGVsZW1lbnQ6IGVsZW1lbnQsXHJcbiAgICAgICAgICAgIHR5cGU6IGVsZW1lbnQudHlwZSA9PT0gJ2NoZWNrYm94JyA/ICdib29sZWFuJ1xyXG4gICAgICAgICAgICAgICAgOiBlbGVtZW50LnR5cGUgPT09ICdudW1iZXInID8gJ251bWJlcicgOiAnc3RyaW5nJyxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBpZiAoZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxTZWxlY3RFbGVtZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBBcnJheS5wcm90b3R5cGUuZmlsdGVyLmNhbGwoZWxlbWVudC5xdWVyeVNlbGVjdG9yQWxsKCdvcHRpb24nKSwgbyA9PiAhIW8udmFsdWUpO1xyXG4gICAgICAgICAgICBmaWVsZEVudHJ5LmFsbG93ZWRWYWx1ZXMgPSBBcnJheS5wcm90b3R5cGUubWFwLmNhbGwob3B0aW9ucywgbyA9PiBvLnRleHRDb250ZW50KTtcclxuICAgICAgICAgICAgZmllbGRFbnRyeS50eXBlID0gJ2ZpeGVkLWNob2ljZXMnO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoaXNSYWRpbykge1xyXG4gICAgICAgICAgICBmaWVsZEVudHJ5LmFsbG93ZWRWYWx1ZXMgPSBbXTtcclxuICAgICAgICAgICAgZmllbGRFbnRyeS50eXBlID0gJ2ZpeGVkLWNob2ljZXMnO1xyXG4gICAgICAgICAgICBBcnJheS5wcm90b3R5cGUuZm9yRWFjaC5jYWxsKGZvcm0ucXVlcnlTZWxlY3RvckFsbCgnaW5wdXRbdHlwZT1yYWRpb10nKSwgZSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZS5uYW1lID09PSBpZGVudGlmaWVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2hvaWNlRGVzY3JpcHRpb24gPSBpbmZlckZpZWxkRGVzY3JpcHRpb24oZm9ybSwgZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNob2ljZURlc2NyaXB0aW9uKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkRW50cnkuYWxsb3dlZFZhbHVlcyEucHVzaChjaG9pY2VEZXNjcmlwdGlvbik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGZpZWxkcy5wdXNoKGZpZWxkRW50cnkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmV0dXJuIGZpZWxkcztcclxufVxyXG5cclxuZnVuY3Rpb24gaW5mZXJGaWVsZERlc2NyaXB0aW9uKGZvcm06IEhUTUxGb3JtRWxlbWVudCwgZWxlbWVudDogSFRNTEVsZW1lbnQpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIC8vIElmIHRoZXJlJ3MgZXhwbGljaXQgY29uZmlnLCB1c2UgaXRcclxuICAgIGNvbnN0IHNtYXJ0UGFzdGVEZXNjcmlwdGlvbiA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKCdkYXRhLXNtYXJ0cGFzdGUtZGVzY3JpcHRpb24nKTtcclxuICAgIGlmIChzbWFydFBhc3RlRGVzY3JpcHRpb24pIHtcclxuICAgICAgICByZXR1cm4gc21hcnRQYXN0ZURlc2NyaXB0aW9uO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIElmIHRoZXJlJ3MgYW4gZXhwbGljaXQgbGFiZWwsIHVzZSBpdFxyXG4gICAgY29uc3QgbGFiZWxzID0gZWxlbWVudC5pZCAmJiBmb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoYGxhYmVsW2Zvcj0nJHtlbGVtZW50LmlkfSddYCk7XHJcbiAgICBpZiAobGFiZWxzICYmIGxhYmVscy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICByZXR1cm4gbGFiZWxzWzBdLnRleHRDb250ZW50LnRyaW0oKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBUcnkgc2VhcmNoaW5nIHVwIHRoZSBET00gaGllcmFyY2h5IHRvIGxvb2sgZm9yIHNvbWUgY29udGFpbmVyIHRoYXQgb25seSBjb250YWluc1xyXG4gICAgLy8gdGhpcyBvbmUgZmllbGQgYW5kIGhhcyB0ZXh0XHJcbiAgICBsZXQgY2FuZGlkYXRlQ29udGFpbmVyID0gZWxlbWVudC5wYXJlbnRFbGVtZW50O1xyXG4gICAgd2hpbGUgKGNhbmRpZGF0ZUNvbnRhaW5lciAmJiBjYW5kaWRhdGVDb250YWluZXIgIT09IGZvcm0ucGFyZW50RWxlbWVudCkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0c0luQ29udGFpbmVyID0gY2FuZGlkYXRlQ29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0LCBzZWxlY3QsIHRleHRhcmVhJyk7XHJcbiAgICAgICAgaWYgKGlucHV0c0luQ29udGFpbmVyLmxlbmd0aCA9PT0gMSAmJiBpbnB1dHNJbkNvbnRhaW5lclswXSA9PT0gZWxlbWVudCkge1xyXG4gICAgICAgICAgICAvLyBIZXJlJ3MgYSBjb250YWluZXIgaW4gd2hpY2ggdGhpcyBlbGVtZW50IGlzIHRoZSBvbmx5IGlucHV0LiBBbnkgdGV4dCBoZXJlXHJcbiAgICAgICAgICAgIC8vIHdpbGwgYmUgYXNzdW1lZCB0byBkZXNjcmliZSB0aGUgaW5wdXQuXHJcbiAgICAgICAgICAgIGxldCB0ZXh0ID0gY2FuZGlkYXRlQ29udGFpbmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCk7XHJcbiAgICAgICAgICAgIGlmICh0ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGV4dDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY2FuZGlkYXRlQ29udGFpbmVyID0gY2FuZGlkYXRlQ29udGFpbmVyLnBhcmVudEVsZW1lbnQ7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gRmFsbCBiYWNrIG9uIG5hbWUgKGJlY2F1c2UgdGhhdCdzIHdoYXQgd291bGQgYmUgYm91bmQgb24gdGhlIHNlcnZlcikgb3IgZXZlbiBJRFxyXG4gICAgLy8gSWYgZXZlbiB0aGVzZSBoYXZlIG5vIGRhdGEsIHdlIHdvbid0IGJlIGFibGUgdG8gdXNlIHRoZSBmaWVsZFxyXG4gICAgcmV0dXJuIGVsZW1lbnQuZ2V0QXR0cmlidXRlKCduYW1lJykgfHwgZWxlbWVudC5pZDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U21hcnRQYXN0ZVJlc3BvbnNlKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGZvcm1Db25maWcsIGNsaXBib2FyZENvbnRlbnRzKTogUHJvbWlzZTxSZXNwb25zZT4ge1xyXG4gICAgY29uc3QgZm9ybUZpZWxkcyA9IGZvcm1Db25maWcubWFwKGVudHJ5ID0+IHJlc3RyaWN0UHJvcGVydGllcyhlbnRyeSwgWydpZGVudGlmaWVyJywgJ2Rlc2NyaXB0aW9uJywgJ2FsbG93ZWRWYWx1ZXMnLCAndHlwZSddKSk7XHJcblxyXG4gICAgY29uc3QgYm9keSA9IHtcclxuICAgICAgICBkYXRhSnNvbjogSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICBmb3JtRmllbGRzLFxyXG4gICAgICAgICAgICBjbGlwYm9hcmRDb250ZW50cyxcclxuICAgICAgICB9KVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBhbnRpZm9yZ2VyeU5hbWUgPSBidXR0b24uZ2V0QXR0cmlidXRlKCdkYXRhLWFudGlmb3JnZXJ5LW5hbWUnKTtcclxuICAgIGlmIChhbnRpZm9yZ2VyeU5hbWUpIHtcclxuICAgICAgICBib2R5W2FudGlmb3JnZXJ5TmFtZV0gPSBidXR0b24uZ2V0QXR0cmlidXRlKCdkYXRhLWFudGlmb3JnZXJ5LXZhbHVlJyk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2UgcmVseSBvbiB0aGUgVVJMIGJlaW5nIHBhdGhiYXNlLXJlbGF0aXZlIGZvciBCbGF6b3IsIG9yIGEgfi8uLi4gVVJMIHRoYXQgd291bGQgYWxyZWFkeVxyXG4gICAgLy8gYmUgcmVzb2x2ZWQgb24gdGhlIHNlcnZlciBmb3IgTVZDXHJcbiAgICBjb25zdCB1cmwgPSBidXR0b24uZ2V0QXR0cmlidXRlKCdkYXRhLXVybCcpO1xyXG4gICAgcmV0dXJuIGZldGNoKHVybCwge1xyXG4gICAgICAgIG1ldGhvZDogJ3Bvc3QnLFxyXG4gICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi94LXd3dy1mb3JtLXVybGVuY29kZWQnLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYm9keTogbmV3IFVSTFNlYXJjaFBhcmFtcyhib2R5KVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc3RyaWN0UHJvcGVydGllcyhvYmplY3QsIHByb3BlcnR5TmFtZXMpIHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xyXG4gICAgcHJvcGVydHlOYW1lcy5mb3JFYWNoKHByb3BlcnR5TmFtZSA9PiB7XHJcbiAgICAgICAgY29uc3QgdmFsdWUgPSBvYmplY3RbcHJvcGVydHlOYW1lXTtcclxuICAgICAgICBpZiAodmFsdWUgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICByZXN1bHRbcHJvcGVydHlOYW1lXSA9IHZhbHVlO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuaW50ZXJmYWNlIEZpZWxkQ29uZmlnIHtcclxuICAgIGlkZW50aWZpZXI6IHN0cmluZztcclxuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgZWxlbWVudDogSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudDtcclxuICAgIHR5cGU6ICdzdHJpbmcnIHwgJ2Jvb2xlYW4nIHwgJ251bWJlcicgfCAnZml4ZWQtY2hvaWNlcyc7XHJcbiAgICBhbGxvd2VkVmFsdWVzPzogc3RyaW5nW107XHJcbn1cclxuIiwidmFyIGF0dHJpYnV0ZXMgPSBbJ2JvcmRlckJvdHRvbVdpZHRoJywgJ2JvcmRlckxlZnRXaWR0aCcsICdib3JkZXJSaWdodFdpZHRoJywgJ2JvcmRlclRvcFN0eWxlJywgJ2JvcmRlclJpZ2h0U3R5bGUnLCAnYm9yZGVyQm90dG9tU3R5bGUnLCAnYm9yZGVyTGVmdFN0eWxlJywgJ2JvcmRlclRvcFdpZHRoJywgJ2JveFNpemluZycsICdmb250RmFtaWx5JywgJ2ZvbnRTaXplJywgJ2ZvbnRXZWlnaHQnLCAnaGVpZ2h0JywgJ2xldHRlclNwYWNpbmcnLCAnbGluZUhlaWdodCcsICdtYXJnaW5Cb3R0b20nLCAnbWFyZ2luTGVmdCcsICdtYXJnaW5SaWdodCcsICdtYXJnaW5Ub3AnLCAnb3V0bGluZVdpZHRoJywgJ292ZXJmbG93JywgJ292ZXJmbG93WCcsICdvdmVyZmxvd1knLCAncGFkZGluZ0JvdHRvbScsICdwYWRkaW5nTGVmdCcsICdwYWRkaW5nUmlnaHQnLCAncGFkZGluZ1RvcCcsICd0ZXh0QWxpZ24nLCAndGV4dE92ZXJmbG93JywgJ3RleHRUcmFuc2Zvcm0nLCAnd2hpdGVTcGFjZScsICd3b3JkQnJlYWsnLCAnd29yZFdyYXAnXTtcbi8qKlxuICogQ3JlYXRlIGEgbWlycm9yXG4gKlxuICogQHBhcmFtIHtFbGVtZW50fSBlbGVtZW50IFRoZSBlbGVtZW50XG4gKiBAcGFyYW0ge3N0cmluZ30gaHRtbCBUaGUgaHRtbFxuICpcbiAqIEByZXR1cm4ge29iamVjdH0gVGhlIG1pcnJvciBvYmplY3RcbiAqL1xuXG52YXIgY3JlYXRlTWlycm9yID0gZnVuY3Rpb24gY3JlYXRlTWlycm9yKGVsZW1lbnQsIGh0bWwpIHtcbiAgLyoqXG4gICAqIFRoZSBtaXJyb3IgZWxlbWVudFxuICAgKi9cbiAgdmFyIG1pcnJvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAvKipcbiAgICogQ3JlYXRlIHRoZSBDU1MgZm9yIHRoZSBtaXJyb3Igb2JqZWN0XG4gICAqXG4gICAqIEByZXR1cm4ge29iamVjdH0gVGhlIHN0eWxlIG9iamVjdFxuICAgKi9cblxuICB2YXIgbWlycm9yQ3NzID0gZnVuY3Rpb24gbWlycm9yQ3NzKCkge1xuICAgIHZhciBjc3MgPSB7XG4gICAgICBwb3NpdGlvbjogJ2Fic29sdXRlJyxcbiAgICAgIGxlZnQ6IC05OTk5LFxuICAgICAgdG9wOiAwLFxuICAgICAgekluZGV4OiAtMjAwMFxuICAgIH07XG5cbiAgICBpZiAoZWxlbWVudC50YWdOYW1lID09PSAnVEVYVEFSRUEnKSB7XG4gICAgICBhdHRyaWJ1dGVzLnB1c2goJ3dpZHRoJyk7XG4gICAgfVxuXG4gICAgYXR0cmlidXRlcy5mb3JFYWNoKGZ1bmN0aW9uIChhdHRyKSB7XG4gICAgICBjc3NbYXR0cl0gPSBnZXRDb21wdXRlZFN0eWxlKGVsZW1lbnQpW2F0dHJdO1xuICAgIH0pO1xuICAgIHJldHVybiBjc3M7XG4gIH07XG4gIC8qKlxuICAgKiBJbml0aWFsaXplIHRoZSBtaXJyb3JcbiAgICpcbiAgICogQHBhcmFtIHtzdHJpbmd9IGh0bWwgVGhlIGh0bWxcbiAgICpcbiAgICogQHJldHVybiB7dm9pZH1cbiAgICovXG5cblxuICB2YXIgaW5pdGlhbGl6ZSA9IGZ1bmN0aW9uIGluaXRpYWxpemUoaHRtbCkge1xuICAgIHZhciBzdHlsZXMgPSBtaXJyb3JDc3MoKTtcbiAgICBPYmplY3Qua2V5cyhzdHlsZXMpLmZvckVhY2goZnVuY3Rpb24gKGtleSkge1xuICAgICAgbWlycm9yLnN0eWxlW2tleV0gPSBzdHlsZXNba2V5XTtcbiAgICB9KTtcbiAgICBtaXJyb3IuaW5uZXJIVE1MID0gaHRtbDtcbiAgICBlbGVtZW50LnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKG1pcnJvciwgZWxlbWVudC5uZXh0U2libGluZyk7XG4gIH07XG4gIC8qKlxuICAgKiBHZXQgdGhlIHJlY3RcbiAgICpcbiAgICogQHJldHVybiB7UmVjdH0gVGhlIGJvdW5kaW5nIHJlY3RcbiAgICovXG5cblxuICB2YXIgcmVjdCA9IGZ1bmN0aW9uIHJlY3QoKSB7XG4gICAgdmFyIG1hcmtlciA9IG1pcnJvci5vd25lckRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYXJldC1wb3NpdGlvbi1tYXJrZXInKTtcbiAgICB2YXIgYm91bmRpbmdSZWN0ID0ge1xuICAgICAgbGVmdDogbWFya2VyLm9mZnNldExlZnQsXG4gICAgICB0b3A6IG1hcmtlci5vZmZzZXRUb3AsXG4gICAgICBoZWlnaHQ6IG1hcmtlci5vZmZzZXRIZWlnaHRcbiAgICB9O1xuICAgIG1pcnJvci5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKG1pcnJvcik7XG4gICAgcmV0dXJuIGJvdW5kaW5nUmVjdDtcbiAgfTtcblxuICBpbml0aWFsaXplKGh0bWwpO1xuICByZXR1cm4ge1xuICAgIHJlY3Q6IHJlY3RcbiAgfTtcbn07XG5cbmZ1bmN0aW9uIF90eXBlb2Yob2JqKSB7XG4gIFwiQGJhYmVsL2hlbHBlcnMgLSB0eXBlb2ZcIjtcblxuICBpZiAodHlwZW9mIFN5bWJvbCA9PT0gXCJmdW5jdGlvblwiICYmIHR5cGVvZiBTeW1ib2wuaXRlcmF0b3IgPT09IFwic3ltYm9sXCIpIHtcbiAgICBfdHlwZW9mID0gZnVuY3Rpb24gKG9iaikge1xuICAgICAgcmV0dXJuIHR5cGVvZiBvYmo7XG4gICAgfTtcbiAgfSBlbHNlIHtcbiAgICBfdHlwZW9mID0gZnVuY3Rpb24gKG9iaikge1xuICAgICAgcmV0dXJuIG9iaiAmJiB0eXBlb2YgU3ltYm9sID09PSBcImZ1bmN0aW9uXCIgJiYgb2JqLmNvbnN0cnVjdG9yID09PSBTeW1ib2wgJiYgb2JqICE9PSBTeW1ib2wucHJvdG90eXBlID8gXCJzeW1ib2xcIiA6IHR5cGVvZiBvYmo7XG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiBfdHlwZW9mKG9iaik7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBET00gRWxlbWVudCBpcyBjb250ZW50IGVkaXRhYmxlXG4gKlxuICogQHBhcmFtIHtFbGVtZW50fSBlbGVtZW50ICBUaGUgRE9NIGVsZW1lbnRcbiAqXG4gKiBAcmV0dXJuIHtib29sfSBJZiBpdCBpcyBjb250ZW50IGVkaXRhYmxlXG4gKi9cbnZhciBpc0NvbnRlbnRFZGl0YWJsZSA9IGZ1bmN0aW9uIGlzQ29udGVudEVkaXRhYmxlKGVsZW1lbnQpIHtcbiAgcmV0dXJuICEhKGVsZW1lbnQuY29udGVudEVkaXRhYmxlID8gZWxlbWVudC5jb250ZW50RWRpdGFibGUgPT09ICd0cnVlJyA6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKCdjb250ZW50ZWRpdGFibGUnKSA9PT0gJ3RydWUnKTtcbn07XG4vKipcbiAqIEdldCB0aGUgY29udGV4dCBmcm9tIHNldHRpbmdzIHBhc3NlZCBpblxuICpcbiAqIEBwYXJhbSB7b2JqZWN0fSBzZXR0aW5ncyBUaGUgc2V0dGluZ3Mgb2JqZWN0XG4gKlxuICogQHJldHVybiB7b2JqZWN0fSB3aW5kb3cgYW5kIGRvY3VtZW50XG4gKi9cblxudmFyIGdldENvbnRleHQgPSBmdW5jdGlvbiBnZXRDb250ZXh0KCkge1xuICB2YXIgc2V0dGluZ3MgPSBhcmd1bWVudHMubGVuZ3RoID4gMCAmJiBhcmd1bWVudHNbMF0gIT09IHVuZGVmaW5lZCA/IGFyZ3VtZW50c1swXSA6IHt9O1xuICB2YXIgY3VzdG9tUG9zID0gc2V0dGluZ3MuY3VzdG9tUG9zLFxuICAgICAgaWZyYW1lID0gc2V0dGluZ3MuaWZyYW1lLFxuICAgICAgbm9TaGFkb3dDYXJldCA9IHNldHRpbmdzLm5vU2hhZG93Q2FyZXQ7XG5cbiAgaWYgKGlmcmFtZSkge1xuICAgIHJldHVybiB7XG4gICAgICBpZnJhbWU6IGlmcmFtZSxcbiAgICAgIHdpbmRvdzogaWZyYW1lLmNvbnRlbnRXaW5kb3csXG4gICAgICBkb2N1bWVudDogaWZyYW1lLmNvbnRlbnREb2N1bWVudCB8fCBpZnJhbWUuY29udGVudFdpbmRvdy5kb2N1bWVudCxcbiAgICAgIG5vU2hhZG93Q2FyZXQ6IG5vU2hhZG93Q2FyZXQsXG4gICAgICBjdXN0b21Qb3M6IGN1c3RvbVBvc1xuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHdpbmRvdzogd2luZG93LFxuICAgIGRvY3VtZW50OiBkb2N1bWVudCxcbiAgICBub1NoYWRvd0NhcmV0OiBub1NoYWRvd0NhcmV0LFxuICAgIGN1c3RvbVBvczogY3VzdG9tUG9zXG4gIH07XG59O1xuLyoqXG4gKiBHZXQgdGhlIG9mZnNldCBvZiBhbiBlbGVtZW50XG4gKlxuICogQHBhcmFtIHtFbGVtZW50fSBlbGVtZW50IFRoZSBET00gZWxlbWVudFxuICogQHBhcmFtIHtvYmplY3R9IGN0eCBUaGUgY29udGV4dFxuICpcbiAqIEByZXR1cm4ge29iamVjdH0gdG9wIGFuZCBsZWZ0XG4gKi9cblxudmFyIGdldE9mZnNldCA9IGZ1bmN0aW9uIGdldE9mZnNldChlbGVtZW50LCBjdHgpIHtcbiAgdmFyIHdpbiA9IGN0eCAmJiBjdHgud2luZG93IHx8IHdpbmRvdztcbiAgdmFyIGRvYyA9IGN0eCAmJiBjdHguZG9jdW1lbnQgfHwgZG9jdW1lbnQ7XG4gIHZhciByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgdmFyIGRvY0VsID0gZG9jLmRvY3VtZW50RWxlbWVudDtcbiAgdmFyIHNjcm9sbExlZnQgPSB3aW4ucGFnZVhPZmZzZXQgfHwgZG9jRWwuc2Nyb2xsTGVmdDtcbiAgdmFyIHNjcm9sbFRvcCA9IHdpbi5wYWdlWU9mZnNldCB8fCBkb2NFbC5zY3JvbGxUb3A7XG4gIHJldHVybiB7XG4gICAgdG9wOiByZWN0LnRvcCArIHNjcm9sbFRvcCxcbiAgICBsZWZ0OiByZWN0LmxlZnQgKyBzY3JvbGxMZWZ0XG4gIH07XG59O1xuLyoqXG4gKiBDaGVjayBpZiBhIHZhbHVlIGlzIGFuIG9iamVjdFxuICpcbiAqIEBwYXJhbSB7YW55fSB2YWx1ZSBUaGUgdmFsdWUgdG8gY2hlY2tcbiAqXG4gKiBAcmV0dXJuIHtib29sfSBJZiBpdCBpcyBhbiBvYmplY3RcbiAqL1xuXG52YXIgaXNPYmplY3QgPSBmdW5jdGlvbiBpc09iamVjdCh2YWx1ZSkge1xuICByZXR1cm4gX3R5cGVvZih2YWx1ZSkgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsO1xufTtcblxuLyoqXG4gKiBDcmVhdGUgYSBJbnB1dCBjYXJldCBvYmplY3QuXG4gKlxuICogQHBhcmFtIHtFbGVtZW50fSBlbGVtZW50IFRoZSBlbGVtZW50XG4gKiBAcGFyYW0ge09iamVjdH0gY3R4IFRoZSBjb250ZXh0XG4gKi9cblxudmFyIGNyZWF0ZUlucHV0Q2FyZXQgPSBmdW5jdGlvbiBjcmVhdGVJbnB1dENhcmV0KGVsZW1lbnQsIGN0eCkge1xuICAvKipcbiAgICogR2V0IHRoZSBjdXJyZW50IHBvc2l0aW9uXG4gICAqXG4gICAqIEByZXR1cm5zIHtpbnR9IFRoZSBjYXJldCBwb3NpdGlvblxuICAgKi9cbiAgdmFyIGdldFBvcyA9IGZ1bmN0aW9uIGdldFBvcygpIHtcbiAgICByZXR1cm4gZWxlbWVudC5zZWxlY3Rpb25TdGFydDtcbiAgfTtcbiAgLyoqXG4gICAqIFNldCB0aGUgcG9zaXRpb25cbiAgICpcbiAgICogQHBhcmFtIHtpbnR9IHBvcyBUaGUgcG9zaXRpb25cbiAgICpcbiAgICogQHJldHVybiB7RWxlbWVudH0gVGhlIGVsZW1lbnRcbiAgICovXG5cblxuICB2YXIgc2V0UG9zID0gZnVuY3Rpb24gc2V0UG9zKHBvcykge1xuICAgIGVsZW1lbnQuc2V0U2VsZWN0aW9uUmFuZ2UocG9zLCBwb3MpO1xuICAgIHJldHVybiBlbGVtZW50O1xuICB9O1xuICAvKipcbiAgICogVGhlIG9mZnNldFxuICAgKlxuICAgKiBAcGFyYW0ge2ludH0gcG9zIFRoZSBwb3NpdGlvblxuICAgKlxuICAgKiBAcmV0dXJuIHtvYmplY3R9IFRoZSBvZmZzZXRcbiAgICovXG5cblxuICB2YXIgZ2V0T2Zmc2V0JDEgPSBmdW5jdGlvbiBnZXRPZmZzZXQkMShwb3MpIHtcbiAgICB2YXIgcmVjdCA9IGdldE9mZnNldChlbGVtZW50KTtcbiAgICB2YXIgcG9zaXRpb24gPSBnZXRQb3NpdGlvbihwb3MpO1xuICAgIHJldHVybiB7XG4gICAgICB0b3A6IHJlY3QudG9wICsgcG9zaXRpb24udG9wICsgY3R4LmRvY3VtZW50LmJvZHkuc2Nyb2xsVG9wLFxuICAgICAgbGVmdDogcmVjdC5sZWZ0ICsgcG9zaXRpb24ubGVmdCArIGN0eC5kb2N1bWVudC5ib2R5LnNjcm9sbExlZnQsXG4gICAgICBoZWlnaHQ6IHBvc2l0aW9uLmhlaWdodFxuICAgIH07XG4gIH07XG4gIC8qKlxuICAgKiBHZXQgdGhlIGN1cnJlbnQgcG9zaXRpb25cbiAgICpcbiAgICogQHBhcmFtIHtpbnR9IHBvcyBUaGUgcG9zaXRpb25cbiAgICpcbiAgICogQHJldHVybiB7b2JqZWN0fSBUaGUgcG9zaXRpb25cbiAgICovXG5cblxuICB2YXIgZ2V0UG9zaXRpb24gPSBmdW5jdGlvbiBnZXRQb3NpdGlvbihwb3MpIHtcbiAgICB2YXIgZm9ybWF0ID0gZnVuY3Rpb24gZm9ybWF0KHZhbCkge1xuICAgICAgdmFyIHZhbHVlID0gdmFsLnJlcGxhY2UoLzx8PnxgfFwifCYvZywgJz8nKS5yZXBsYWNlKC9cXHJcXG58XFxyfFxcbi9nLCAnPGJyLz4nKTtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9O1xuXG4gICAgaWYgKGN0eC5jdXN0b21Qb3MgfHwgY3R4LmN1c3RvbVBvcyA9PT0gMCkge1xuICAgICAgcG9zID0gY3R4LmN1c3RvbVBvcztcbiAgICB9XG5cbiAgICB2YXIgcG9zaXRpb24gPSBwb3MgPT09IHVuZGVmaW5lZCA/IGdldFBvcygpIDogcG9zO1xuICAgIHZhciBzdGFydFJhbmdlID0gZWxlbWVudC52YWx1ZS5zbGljZSgwLCBwb3NpdGlvbik7XG4gICAgdmFyIGVuZFJhbmdlID0gZWxlbWVudC52YWx1ZS5zbGljZShwb3NpdGlvbik7XG4gICAgdmFyIGh0bWwgPSBcIjxzcGFuIHN0eWxlPVxcXCJwb3NpdGlvbjogcmVsYXRpdmU7IGRpc3BsYXk6IGlubGluZTtcXFwiPlwiLmNvbmNhdChmb3JtYXQoc3RhcnRSYW5nZSksIFwiPC9zcGFuPlwiKTtcbiAgICBodG1sICs9ICc8c3BhbiBpZD1cImNhcmV0LXBvc2l0aW9uLW1hcmtlclwiIHN0eWxlPVwicG9zaXRpb246IHJlbGF0aXZlOyBkaXNwbGF5OiBpbmxpbmU7XCI+fDwvc3Bhbj4nO1xuICAgIGh0bWwgKz0gXCI8c3BhbiBzdHlsZT1cXFwicG9zaXRpb246IHJlbGF0aXZlOyBkaXNwbGF5OiBpbmxpbmU7XFxcIj5cIi5jb25jYXQoZm9ybWF0KGVuZFJhbmdlKSwgXCI8L3NwYW4+XCIpO1xuICAgIHZhciBtaXJyb3IgPSBjcmVhdGVNaXJyb3IoZWxlbWVudCwgaHRtbCk7XG4gICAgdmFyIHJlY3QgPSBtaXJyb3IucmVjdCgpO1xuICAgIHJlY3QucG9zID0gZ2V0UG9zKCk7XG4gICAgcmV0dXJuIHJlY3Q7XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBnZXRQb3M6IGdldFBvcyxcbiAgICBzZXRQb3M6IHNldFBvcyxcbiAgICBnZXRPZmZzZXQ6IGdldE9mZnNldCQxLFxuICAgIGdldFBvc2l0aW9uOiBnZXRQb3NpdGlvblxuICB9O1xufTtcblxuLyoqXG4gKiBDcmVhdGUgYW4gRWRpdGFibGUgQ2FyZXRcbiAqIEBwYXJhbSB7RWxlbWVudH0gZWxlbWVudCBUaGUgZWRpdGFibGUgZWxlbWVudFxuICogQHBhcmFtIHtvYmplY3R8bnVsbH0gY3R4IFRoZSBjb250ZXh0XG4gKlxuICogQHJldHVybiB7RWRpdGFibGVDYXJldH1cbiAqL1xudmFyIGNyZWF0ZUVkaXRhYmxlQ2FyZXQgPSBmdW5jdGlvbiBjcmVhdGVFZGl0YWJsZUNhcmV0KGVsZW1lbnQsIGN0eCkge1xuICAvKipcbiAgICogU2V0IHRoZSBjYXJldCBwb3NpdGlvblxuICAgKlxuICAgKiBAcGFyYW0ge2ludH0gcG9zIFRoZSBwb3NpdGlvbiB0byBzZVxuICAgKlxuICAgKiBAcmV0dXJuIHtFbGVtZW50fSBUaGUgZWxlbWVudFxuICAgKi9cbiAgdmFyIHNldFBvcyA9IGZ1bmN0aW9uIHNldFBvcyhwb3MpIHtcbiAgICB2YXIgc2VsID0gY3R4LndpbmRvdy5nZXRTZWxlY3Rpb24oKTtcblxuICAgIGlmIChzZWwpIHtcbiAgICAgIHZhciBvZmZzZXQgPSAwO1xuICAgICAgdmFyIGZvdW5kID0gZmFsc2U7XG5cbiAgICAgIHZhciBmaW5kID0gZnVuY3Rpb24gZmluZChwb3NpdGlvbiwgcGFyZW50KSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcGFyZW50LmNoaWxkTm9kZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICB2YXIgbm9kZSA9IHBhcmVudC5jaGlsZE5vZGVzW2ldO1xuXG4gICAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAobm9kZS5ub2RlVHlwZSA9PT0gMykge1xuICAgICAgICAgICAgaWYgKG9mZnNldCArIG5vZGUubGVuZ3RoID49IHBvc2l0aW9uKSB7XG4gICAgICAgICAgICAgIGZvdW5kID0gdHJ1ZTtcbiAgICAgICAgICAgICAgdmFyIHJhbmdlID0gY3R4LmRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7XG4gICAgICAgICAgICAgIHJhbmdlLnNldFN0YXJ0KG5vZGUsIHBvc2l0aW9uIC0gb2Zmc2V0KTtcbiAgICAgICAgICAgICAgc2VsLnJlbW92ZUFsbFJhbmdlcygpO1xuICAgICAgICAgICAgICBzZWwuYWRkUmFuZ2UocmFuZ2UpO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIG9mZnNldCArPSBub2RlLmxlbmd0aDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZmluZChwb3MsIG5vZGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgZmluZChwb3MsIGVsZW1lbnQpO1xuICAgIH1cblxuICAgIHJldHVybiBlbGVtZW50O1xuICB9O1xuICAvKipcbiAgICogR2V0IHRoZSBvZmZzZXRcbiAgICpcbiAgICogQHJldHVybiB7b2JqZWN0fSBUaGUgb2Zmc2V0XG4gICAqL1xuXG5cbiAgdmFyIGdldE9mZnNldCA9IGZ1bmN0aW9uIGdldE9mZnNldCgpIHtcbiAgICB2YXIgcmFuZ2UgPSBnZXRSYW5nZSgpO1xuICAgIHZhciBvZmZzZXQgPSB7XG4gICAgICBoZWlnaHQ6IDAsXG4gICAgICBsZWZ0OiAwLFxuICAgICAgcmlnaHQ6IDBcbiAgICB9O1xuXG4gICAgaWYgKCFyYW5nZSkge1xuICAgICAgcmV0dXJuIG9mZnNldDtcbiAgICB9XG5cbiAgICB2YXIgaGFzQ3VzdG9tUG9zID0gY3R4LmN1c3RvbVBvcyB8fCBjdHguY3VzdG9tUG9zID09PSAwOyAvLyBlbmRDb250YWluZXIgaW4gRmlyZWZveCB3b3VsZCBiZSB0aGUgZWxlbWVudCBhdCB0aGUgc3RhcnQgb2ZcbiAgICAvLyB0aGUgbGluZVxuXG4gICAgaWYgKHJhbmdlLmVuZE9mZnNldCAtIDEgPiAwICYmIHJhbmdlLmVuZENvbnRhaW5lciAhPT0gZWxlbWVudCB8fCBoYXNDdXN0b21Qb3MpIHtcbiAgICAgIHZhciBjbG9uZWRSYW5nZSA9IHJhbmdlLmNsb25lUmFuZ2UoKTtcbiAgICAgIHZhciBmaXhlZFBvc2l0aW9uID0gaGFzQ3VzdG9tUG9zID8gY3R4LmN1c3RvbVBvcyA6IHJhbmdlLmVuZE9mZnNldDtcbiAgICAgIGNsb25lZFJhbmdlLnNldFN0YXJ0KHJhbmdlLmVuZENvbnRhaW5lciwgZml4ZWRQb3NpdGlvbiAtIDEgPCAwID8gMCA6IGZpeGVkUG9zaXRpb24gLSAxKTtcbiAgICAgIGNsb25lZFJhbmdlLnNldEVuZChyYW5nZS5lbmRDb250YWluZXIsIGZpeGVkUG9zaXRpb24pO1xuICAgICAgdmFyIHJlY3QgPSBjbG9uZWRSYW5nZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIG9mZnNldCA9IHtcbiAgICAgICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgICAgICAgbGVmdDogcmVjdC5sZWZ0ICsgcmVjdC53aWR0aCxcbiAgICAgICAgdG9wOiByZWN0LnRvcFxuICAgICAgfTtcbiAgICAgIGNsb25lZFJhbmdlLmRldGFjaCgpO1xuICAgIH1cblxuICAgIGlmICgoIW9mZnNldCB8fCBvZmZzZXQgJiYgb2Zmc2V0LmhlaWdodCA9PT0gMCkgJiYgIWN0eC5ub1NoYWRvd0NhcmV0KSB7XG4gICAgICB2YXIgX2Nsb25lZFJhbmdlID0gcmFuZ2UuY2xvbmVSYW5nZSgpO1xuXG4gICAgICB2YXIgc2hhZG93Q2FyZXQgPSBjdHguZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoJ3wnKTtcblxuICAgICAgX2Nsb25lZFJhbmdlLmluc2VydE5vZGUoc2hhZG93Q2FyZXQpO1xuXG4gICAgICBfY2xvbmVkUmFuZ2Uuc2VsZWN0Tm9kZShzaGFkb3dDYXJldCk7XG5cbiAgICAgIHZhciBfcmVjdCA9IF9jbG9uZWRSYW5nZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcblxuICAgICAgb2Zmc2V0ID0ge1xuICAgICAgICBoZWlnaHQ6IF9yZWN0LmhlaWdodCxcbiAgICAgICAgbGVmdDogX3JlY3QubGVmdCxcbiAgICAgICAgdG9wOiBfcmVjdC50b3BcbiAgICAgIH07XG4gICAgICBzaGFkb3dDYXJldC5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKHNoYWRvd0NhcmV0KTtcblxuICAgICAgX2Nsb25lZFJhbmdlLmRldGFjaCgpO1xuICAgIH1cblxuICAgIGlmIChvZmZzZXQpIHtcbiAgICAgIHZhciBkb2MgPSBjdHguZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICAgICAgb2Zmc2V0LnRvcCArPSBjdHgud2luZG93LnBhZ2VZT2Zmc2V0IC0gKGRvYy5jbGllbnRUb3AgfHwgMCk7XG4gICAgICBvZmZzZXQubGVmdCArPSBjdHgud2luZG93LnBhZ2VYT2Zmc2V0IC0gKGRvYy5jbGllbnRMZWZ0IHx8IDApO1xuICAgIH1cblxuICAgIHJldHVybiBvZmZzZXQ7XG4gIH07XG4gIC8qKlxuICAgKiBHZXQgdGhlIHBvc2l0aW9uXG4gICAqXG4gICAqIEByZXR1cm4ge29iamVjdH0gVGhlIHBvc2l0aW9uXG4gICAqL1xuXG5cbiAgdmFyIGdldFBvc2l0aW9uID0gZnVuY3Rpb24gZ2V0UG9zaXRpb24oKSB7XG4gICAgdmFyIG9mZnNldCA9IGdldE9mZnNldCgpO1xuICAgIHZhciBwb3MgPSBnZXRQb3MoKTtcbiAgICB2YXIgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgdmFyIGlucHV0T2Zmc2V0ID0ge1xuICAgICAgdG9wOiByZWN0LnRvcCArIGN0eC5kb2N1bWVudC5ib2R5LnNjcm9sbFRvcCxcbiAgICAgIGxlZnQ6IHJlY3QubGVmdCArIGN0eC5kb2N1bWVudC5ib2R5LnNjcm9sbExlZnRcbiAgICB9O1xuICAgIG9mZnNldC5sZWZ0IC09IGlucHV0T2Zmc2V0LmxlZnQ7XG4gICAgb2Zmc2V0LnRvcCAtPSBpbnB1dE9mZnNldC50b3A7XG4gICAgb2Zmc2V0LnBvcyA9IHBvcztcbiAgICByZXR1cm4gb2Zmc2V0O1xuICB9O1xuICAvKipcbiAgICogR2V0IHRoZSByYW5nZVxuICAgKlxuICAgKiBAcmV0dXJuIHtSYW5nZXxudWxsfVxuICAgKi9cblxuXG4gIHZhciBnZXRSYW5nZSA9IGZ1bmN0aW9uIGdldFJhbmdlKCkge1xuICAgIGlmICghY3R4LndpbmRvdy5nZXRTZWxlY3Rpb24pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB2YXIgc2VsID0gY3R4LndpbmRvdy5nZXRTZWxlY3Rpb24oKTtcbiAgICByZXR1cm4gc2VsLnJhbmdlQ291bnQgPiAwID8gc2VsLmdldFJhbmdlQXQoMCkgOiBudWxsO1xuICB9O1xuICAvKipcbiAgICogR2V0IHRoZSBjYXJldCBwb3NpdGlvblxuICAgKlxuICAgKiBAcmV0dXJuIHtpbnR9IFRoZSBwb3NpdGlvblxuICAgKi9cblxuXG4gIHZhciBnZXRQb3MgPSBmdW5jdGlvbiBnZXRQb3MoKSB7XG4gICAgdmFyIHJhbmdlID0gZ2V0UmFuZ2UoKTtcbiAgICB2YXIgY2xvbmVkUmFuZ2UgPSByYW5nZS5jbG9uZVJhbmdlKCk7XG4gICAgY2xvbmVkUmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsZW1lbnQpO1xuICAgIGNsb25lZFJhbmdlLnNldEVuZChyYW5nZS5lbmRDb250YWluZXIsIHJhbmdlLmVuZE9mZnNldCk7XG4gICAgdmFyIHBvcyA9IGNsb25lZFJhbmdlLnRvU3RyaW5nKCkubGVuZ3RoO1xuICAgIGNsb25lZFJhbmdlLmRldGFjaCgpO1xuICAgIHJldHVybiBwb3M7XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBnZXRQb3M6IGdldFBvcyxcbiAgICBzZXRQb3M6IHNldFBvcyxcbiAgICBnZXRQb3NpdGlvbjogZ2V0UG9zaXRpb24sXG4gICAgZ2V0T2Zmc2V0OiBnZXRPZmZzZXQsXG4gICAgZ2V0UmFuZ2U6IGdldFJhbmdlXG4gIH07XG59O1xuXG52YXIgY3JlYXRlQ2FyZXQgPSBmdW5jdGlvbiBjcmVhdGVDYXJldChlbGVtZW50LCBjdHgpIHtcbiAgaWYgKGlzQ29udGVudEVkaXRhYmxlKGVsZW1lbnQpKSB7XG4gICAgcmV0dXJuIGNyZWF0ZUVkaXRhYmxlQ2FyZXQoZWxlbWVudCwgY3R4KTtcbiAgfVxuXG4gIHJldHVybiBjcmVhdGVJbnB1dENhcmV0KGVsZW1lbnQsIGN0eCk7XG59O1xuXG52YXIgcG9zaXRpb24gPSBmdW5jdGlvbiBwb3NpdGlvbihlbGVtZW50LCB2YWx1ZSkge1xuICB2YXIgc2V0dGluZ3MgPSBhcmd1bWVudHMubGVuZ3RoID4gMiAmJiBhcmd1bWVudHNbMl0gIT09IHVuZGVmaW5lZCA/IGFyZ3VtZW50c1syXSA6IHt9O1xuICB2YXIgb3B0aW9ucyA9IHNldHRpbmdzO1xuXG4gIGlmIChpc09iamVjdCh2YWx1ZSkpIHtcbiAgICBvcHRpb25zID0gdmFsdWU7XG4gICAgdmFsdWUgPSBudWxsO1xuICB9XG5cbiAgdmFyIGN0eCA9IGdldENvbnRleHQob3B0aW9ucyk7XG4gIHZhciBjYXJldCA9IGNyZWF0ZUNhcmV0KGVsZW1lbnQsIGN0eCk7XG5cbiAgaWYgKHZhbHVlIHx8IHZhbHVlID09PSAwKSB7XG4gICAgcmV0dXJuIGNhcmV0LnNldFBvcyh2YWx1ZSk7XG4gIH1cblxuICByZXR1cm4gY2FyZXQuZ2V0UG9zaXRpb24oKTtcbn07XG4vKipcbiAqXG4gKiBAcGFyYW0ge0VsZW1lbnR9IGVsZW1lbnQgVGhlIERPTSBlbGVtZW50XG4gKiBAcGFyYW0ge251bWJlcnx1bmRlZmluZWR9IHZhbHVlIFRoZSB2YWx1ZSB0byBzZXRcbiAqIEBwYXJhbSB7b2JqZWN0fSBzZXR0aW5ncyBBbnkgc2V0dGluZ3MgZm9yIGNvbnRleHRcbiAqL1xuXG52YXIgb2Zmc2V0ID0gZnVuY3Rpb24gb2Zmc2V0KGVsZW1lbnQsIHZhbHVlKSB7XG4gIHZhciBzZXR0aW5ncyA9IGFyZ3VtZW50cy5sZW5ndGggPiAyICYmIGFyZ3VtZW50c1syXSAhPT0gdW5kZWZpbmVkID8gYXJndW1lbnRzWzJdIDoge307XG4gIHZhciBvcHRpb25zID0gc2V0dGluZ3M7XG5cbiAgaWYgKGlzT2JqZWN0KHZhbHVlKSkge1xuICAgIG9wdGlvbnMgPSB2YWx1ZTtcbiAgICB2YWx1ZSA9IG51bGw7XG4gIH1cblxuICB2YXIgY3R4ID0gZ2V0Q29udGV4dChvcHRpb25zKTtcbiAgdmFyIGNhcmV0ID0gY3JlYXRlQ2FyZXQoZWxlbWVudCwgY3R4KTtcbiAgcmV0dXJuIGNhcmV0LmdldE9mZnNldCh2YWx1ZSk7XG59O1xuXG5leHBvcnQgeyBnZXRPZmZzZXQsIG9mZnNldCwgcG9zaXRpb24gfTtcbi8vIyBzb3VyY2VNYXBwaW5nVVJMPW1haW4uanMubWFwXG4iLCJpbXBvcnQgKiBhcyBjYXJldFBvcyBmcm9tICdjYXJldC1wb3MnO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNjcm9sbFRleHRBcmVhRG93blRvQ2FyZXRJZk5lZWRlZCh0ZXh0QXJlYTogSFRNTFRleHRBcmVhRWxlbWVudCkge1xyXG4gICAgLy8gTm90ZSB0aGF0IHRoaXMgb25seSBzY3JvbGxzICpkb3duKiwgYmVjYXVzZSB0aGF0J3MgdGhlIG9ubHkgc2NlbmFyaW8gYWZ0ZXIgYSBzdWdnZXN0aW9uIGlzIGFjY2VwdGVkXHJcbiAgICBjb25zdCBwb3MgPSBjYXJldFBvcy5wb3NpdGlvbih0ZXh0QXJlYSk7XHJcbiAgICBjb25zdCBsaW5lSGVpZ2h0SW5QaXhlbHMgPSBwYXJzZUZsb2F0KHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKHRleHRBcmVhKS5saW5lSGVpZ2h0KTtcclxuICAgIGlmIChwb3MudG9wID4gdGV4dEFyZWEuY2xpZW50SGVpZ2h0ICsgdGV4dEFyZWEuc2Nyb2xsVG9wIC0gbGluZUhlaWdodEluUGl4ZWxzKSB7XHJcbiAgICAgICAgdGV4dEFyZWEuc2Nyb2xsVG9wID0gcG9zLnRvcCAtIHRleHRBcmVhLmNsaWVudEhlaWdodCArIGxpbmVIZWlnaHRJblBpeGVscztcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldENhcmV0T2Zmc2V0RnJvbU9mZnNldFBhcmVudChlbGVtOiBIVE1MVGV4dEFyZWFFbGVtZW50KTogeyB0b3A6IG51bWJlciwgbGVmdDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlciwgZWxlbVN0eWxlOiBDU1NTdHlsZURlY2xhcmF0aW9uIH0ge1xyXG4gICAgY29uc3QgZWxlbVN0eWxlID0gd2luZG93LmdldENvbXB1dGVkU3R5bGUoZWxlbSk7XHJcbiAgICBjb25zdCBwb3MgPSBjYXJldFBvcy5wb3NpdGlvbihlbGVtKTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHRvcDogcG9zLnRvcCArIHBhcnNlRmxvYXQoZWxlbVN0eWxlLmJvcmRlclRvcFdpZHRoKSArIGVsZW0ub2Zmc2V0VG9wIC0gZWxlbS5zY3JvbGxUb3AsXHJcbiAgICAgICAgbGVmdDogcG9zLmxlZnQgKyBwYXJzZUZsb2F0KGVsZW1TdHlsZS5ib3JkZXJMZWZ0V2lkdGgpICsgZWxlbS5vZmZzZXRMZWZ0IC0gZWxlbS5zY3JvbGxMZWZ0IC0gMC4yNSxcclxuICAgICAgICBoZWlnaHQ6IHBvcy5oZWlnaHQsXHJcbiAgICAgICAgZWxlbVN0eWxlOiBlbGVtU3R5bGUsXHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnNlcnRUZXh0QXRDYXJldFBvc2l0aW9uKHRleHRBcmVhOiBIVE1MVGV4dEFyZWFFbGVtZW50LCB0ZXh0OiBzdHJpbmcpIHtcclxuICAgIC8vIEV2ZW4gdGhvdWdoIGRvY3VtZW50LmV4ZWNDb21tYW5kIGlzIGRlcHJlY2F0ZWQsIGl0J3Mgc3RpbGwgdGhlIGJlc3Qgd2F5IHRvIGluc2VydCB0ZXh0LCBiZWNhdXNlIGl0J3NcclxuICAgIC8vIHRoZSBvbmx5IHdheSB0aGF0IGludGVyYWN0cyBjb3JyZWN0bHkgd2l0aCB0aGUgdW5kbyBidWZmZXIuIElmIHdlIGhhdmUgdG8gZmFsbCBiYWNrIG9uIG11dGF0aW5nXHJcbiAgICAvLyB0aGUgLnZhbHVlIHByb3BlcnR5IGRpcmVjdGx5LCBpdCB3b3JrcyBidXQgZXJhc2VzIHRoZSB1bmRvIGJ1ZmZlci5cclxuICAgIGlmIChkb2N1bWVudC5leGVjQ29tbWFuZCkge1xyXG4gICAgICAgIGRvY3VtZW50LmV4ZWNDb21tYW5kKCdpbnNlcnRUZXh0JywgZmFsc2UsIHRleHQpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBsZXQgY2FyZXRQb3MgPSB0ZXh0QXJlYS5zZWxlY3Rpb25TdGFydDtcclxuICAgICAgICB0ZXh0QXJlYS52YWx1ZSA9IHRleHRBcmVhLnZhbHVlLnN1YnN0cmluZygwLCBjYXJldFBvcylcclxuICAgICAgICAgICAgKyB0ZXh0XHJcbiAgICAgICAgICAgICsgdGV4dEFyZWEudmFsdWUuc3Vic3RyaW5nKHRleHRBcmVhLnNlbGVjdGlvbkVuZCk7XHJcbiAgICAgICAgY2FyZXRQb3MgKz0gdGV4dC5sZW5ndGg7XHJcbiAgICAgICAgdGV4dEFyZWEuc2V0U2VsZWN0aW9uUmFuZ2UoY2FyZXRQb3MsIGNhcmV0UG9zKTtcclxuICAgIH1cclxufVxyXG4iLCJpbXBvcnQgeyBTdWdnZXN0aW9uRGlzcGxheSB9IGZyb20gJy4vU3VnZ2VzdGlvbkRpc3BsYXknO1xyXG5pbXBvcnQgeyBTbWFydFRleHRBcmVhIH0gZnJvbSAnLi9TbWFydFRleHRBcmVhJztcclxuaW1wb3J0IHsgZ2V0Q2FyZXRPZmZzZXRGcm9tT2Zmc2V0UGFyZW50LCBzY3JvbGxUZXh0QXJlYURvd25Ub0NhcmV0SWZOZWVkZWQgfSBmcm9tICcuL0NhcmV0VXRpbCc7XHJcblxyXG5leHBvcnQgY2xhc3MgSW5saW5lU3VnZ2VzdGlvbkRpc3BsYXkgaW1wbGVtZW50cyBTdWdnZXN0aW9uRGlzcGxheSB7XHJcbiAgICBsYXRlc3RTdWdnZXN0aW9uVGV4dDogc3RyaW5nID0gJyc7XHJcbiAgICBzdWdnZXN0aW9uU3RhcnRQb3M6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG4gICAgc3VnZ2VzdGlvbkVuZFBvczogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICBmYWtlQ2FyZXQ6IEZha2VDYXJldCB8IG51bGwgPSBudWxsO1xyXG4gICAgb3JpZ2luYWxWYWx1ZVByb3BlcnR5OiBQcm9wZXJ0eURlc2NyaXB0b3I7XHJcblxyXG4gICAgY29uc3RydWN0b3IocHJpdmF0ZSBvd25lcjogU21hcnRUZXh0QXJlYSwgcHJpdmF0ZSB0ZXh0QXJlYTogSFRNTFRleHRBcmVhRWxlbWVudCkge1xyXG4gICAgICAgIC8vIFdoZW4gYW55IG90aGVyIEpTIGNvZGUgYXNrcyBmb3IgdGhlIHZhbHVlIG9mIHRoZSB0ZXh0YXJlYSwgd2Ugd2FudCB0byByZXR1cm4gdGhlIHZhbHVlXHJcbiAgICAgICAgLy8gd2l0aG91dCBhbnkgcGVuZGluZyBzdWdnZXN0aW9uLCBvdGhlcndpc2UgaXQgd2lsbCBicmVhayB0aGluZ3MgbGlrZSBiaW5kaW5nc1xyXG4gICAgICAgIHRoaXMub3JpZ2luYWxWYWx1ZVByb3BlcnR5ID0gZmluZFByb3BlcnR5UmVjdXJzaXZlKHRleHRBcmVhLCAndmFsdWUnKTtcclxuICAgICAgICBjb25zdCBzZWxmID0gdGhpcztcclxuICAgICAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGV4dEFyZWEsICd2YWx1ZScsIHtcclxuICAgICAgICAgICAgZ2V0KCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdHJ1ZVZhbHVlID0gc2VsZi5vcmlnaW5hbFZhbHVlUHJvcGVydHkuZ2V0LmNhbGwodGV4dEFyZWEpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNlbGYuaXNTaG93aW5nKClcclxuICAgICAgICAgICAgICAgICAgICA/IHRydWVWYWx1ZS5zdWJzdHJpbmcoMCwgc2VsZi5zdWdnZXN0aW9uU3RhcnRQb3MpICsgdHJ1ZVZhbHVlLnN1YnN0cmluZyhzZWxmLnN1Z2dlc3Rpb25FbmRQb3MpXHJcbiAgICAgICAgICAgICAgICAgICAgOiB0cnVlVmFsdWU7XHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIHNldCh2KSB7XHJcbiAgICAgICAgICAgICAgICBzZWxmLm9yaWdpbmFsVmFsdWVQcm9wZXJ0eS5zZXQuY2FsbCh0ZXh0QXJlYSwgdik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBnZXQgdmFsdWVJbmNsdWRpbmdTdWdnZXN0aW9uKCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLm9yaWdpbmFsVmFsdWVQcm9wZXJ0eS5nZXQuY2FsbCh0aGlzLnRleHRBcmVhKTtcclxuICAgIH1cclxuXHJcbiAgICBzZXQgdmFsdWVJbmNsdWRpbmdTdWdnZXN0aW9uKHZhbDogc3RyaW5nKSB7XHJcbiAgICAgICAgdGhpcy5vcmlnaW5hbFZhbHVlUHJvcGVydHkuc2V0LmNhbGwodGhpcy50ZXh0QXJlYSwgdmFsKTtcclxuICAgIH1cclxuXHJcbiAgICBpc1Nob3dpbmcoKTogYm9vbGVhbiB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuc3VnZ2VzdGlvblN0YXJ0UG9zICE9PSBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHNob3coc3VnZ2VzdGlvbjogc3RyaW5nKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy5sYXRlc3RTdWdnZXN0aW9uVGV4dCA9IHN1Z2dlc3Rpb247XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uU3RhcnRQb3MgPSB0aGlzLnRleHRBcmVhLnNlbGVjdGlvblN0YXJ0O1xyXG4gICAgICAgIHRoaXMuc3VnZ2VzdGlvbkVuZFBvcyA9IHRoaXMuc3VnZ2VzdGlvblN0YXJ0UG9zICsgc3VnZ2VzdGlvbi5sZW5ndGg7XHJcblxyXG4gICAgICAgIHRoaXMudGV4dEFyZWEuc2V0QXR0cmlidXRlKCdkYXRhLXN1Z2dlc3Rpb24tdmlzaWJsZScsICcnKTtcclxuICAgICAgICB0aGlzLnZhbHVlSW5jbHVkaW5nU3VnZ2VzdGlvbiA9IHRoaXMudmFsdWVJbmNsdWRpbmdTdWdnZXN0aW9uLnN1YnN0cmluZygwLCB0aGlzLnN1Z2dlc3Rpb25TdGFydFBvcykgKyBzdWdnZXN0aW9uICsgdGhpcy52YWx1ZUluY2x1ZGluZ1N1Z2dlc3Rpb24uc3Vic3RyaW5nKHRoaXMuc3VnZ2VzdGlvblN0YXJ0UG9zKTtcclxuICAgICAgICB0aGlzLnRleHRBcmVhLnNldFNlbGVjdGlvblJhbmdlKHRoaXMuc3VnZ2VzdGlvblN0YXJ0UG9zLCB0aGlzLnN1Z2dlc3Rpb25FbmRQb3MpO1xyXG5cclxuICAgICAgICB0aGlzLmZha2VDYXJldCA/Pz0gbmV3IEZha2VDYXJldCh0aGlzLm93bmVyLCB0aGlzLnRleHRBcmVhKTtcclxuICAgICAgICB0aGlzLmZha2VDYXJldC5zaG93KCk7XHJcbiAgICB9XHJcblxyXG4gICAgZ2V0IGN1cnJlbnRTdWdnZXN0aW9uKCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLmxhdGVzdFN1Z2dlc3Rpb25UZXh0O1xyXG4gICAgfVxyXG5cclxuICAgIGFjY2VwdCgpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLnRleHRBcmVhLnNldFNlbGVjdGlvblJhbmdlKHRoaXMuc3VnZ2VzdGlvbkVuZFBvcywgdGhpcy5zdWdnZXN0aW9uRW5kUG9zKTtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25TdGFydFBvcyA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uRW5kUG9zID0gbnVsbDtcclxuICAgICAgICB0aGlzLmZha2VDYXJldD8uaGlkZSgpO1xyXG4gICAgICAgIHRoaXMudGV4dEFyZWEucmVtb3ZlQXR0cmlidXRlKCdkYXRhLXN1Z2dlc3Rpb24tdmlzaWJsZScpO1xyXG5cclxuICAgICAgICAvLyBUaGUgbmV3bHktaW5zZXJ0ZWQgdGV4dCBjb3VsZCBiZSBzbyBsb25nIHRoYXQgdGhlIG5ldyBjYXJldCBwb3NpdGlvbiBpcyBvZmYgdGhlIGJvdHRvbSBvZiB0aGUgdGV4dGFyZWEuXHJcbiAgICAgICAgLy8gSXQgd29uJ3Qgc2Nyb2xsIHRvIHRoZSBuZXcgY2FyZXQgcG9zaXRpb24gYnkgZGVmYXVsdFxyXG4gICAgICAgIHNjcm9sbFRleHRBcmVhRG93blRvQ2FyZXRJZk5lZWRlZCh0aGlzLnRleHRBcmVhKTtcclxuICAgIH1cclxuXHJcbiAgICByZWplY3QoKTogdm9pZCB7XHJcbiAgICAgICAgaWYgKCF0aGlzLmlzU2hvd2luZygpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjsgLy8gTm8gc3VnZ2VzdGlvbiBpcyBzaG93blxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgcHJldlNlbGVjdGlvblN0YXJ0ID0gdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25TdGFydDtcclxuICAgICAgICBjb25zdCBwcmV2U2VsZWN0aW9uRW5kID0gdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25FbmQ7XHJcbiAgICAgICAgdGhpcy52YWx1ZUluY2x1ZGluZ1N1Z2dlc3Rpb24gPSB0aGlzLnZhbHVlSW5jbHVkaW5nU3VnZ2VzdGlvbi5zdWJzdHJpbmcoMCwgdGhpcy5zdWdnZXN0aW9uU3RhcnRQb3MpICsgdGhpcy52YWx1ZUluY2x1ZGluZ1N1Z2dlc3Rpb24uc3Vic3RyaW5nKHRoaXMuc3VnZ2VzdGlvbkVuZFBvcyk7XHJcblxyXG4gICAgICAgIGlmICh0aGlzLnN1Z2dlc3Rpb25TdGFydFBvcyA9PT0gcHJldlNlbGVjdGlvblN0YXJ0ICYmIHRoaXMuc3VnZ2VzdGlvbkVuZFBvcyA9PT0gcHJldlNlbGVjdGlvbkVuZCkge1xyXG4gICAgICAgICAgICAvLyBGb3IgbW9zdCBpbnRlcmFjdGlvbnMgd2UgZG9uJ3QgbmVlZCB0byBkbyBhbnl0aGluZyB0byBwcmVzZXJ2ZSB0aGUgY3Vyc29yIHBvc2l0aW9uLCBidXQgZm9yXHJcbiAgICAgICAgICAgIC8vICdzY3JvbGwnIGV2ZW50cyB3ZSBkbyAoYmVjYXVzZSB0aGUgaW50ZXJhY3Rpb24gaXNuJ3QgZ29pbmcgdG8gc2V0IGEgY3Vyc29yIHBvc2l0aW9uIG5hdHVyYWxseSlcclxuICAgICAgICAgICAgdGhpcy50ZXh0QXJlYS5zZXRTZWxlY3Rpb25SYW5nZShwcmV2U2VsZWN0aW9uU3RhcnQsIHByZXZTZWxlY3Rpb25TdGFydCAvKiBub3QgJ2VuZCcgYmVjYXVzZSB3ZSByZW1vdmVkIHRoZSBzdWdnZXN0aW9uICovKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMuc3VnZ2VzdGlvblN0YXJ0UG9zID0gbnVsbDtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbmRQb3MgPSBudWxsO1xyXG4gICAgICAgIHRoaXMudGV4dEFyZWEucmVtb3ZlQXR0cmlidXRlKCdkYXRhLXN1Z2dlc3Rpb24tdmlzaWJsZScpO1xyXG4gICAgICAgIHRoaXMuZmFrZUNhcmV0Py5oaWRlKCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmNsYXNzIEZha2VDYXJldCB7XHJcbiAgICByZWFkb25seSBjYXJldERpdjogSFRNTERpdkVsZW1lbnQ7XHJcblxyXG4gICAgY29uc3RydWN0b3Iob3duZXI6IFNtYXJ0VGV4dEFyZWEsIHByaXZhdGUgdGV4dEFyZWE6IEhUTUxUZXh0QXJlYUVsZW1lbnQpIHtcclxuICAgICAgICB0aGlzLmNhcmV0RGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgdGhpcy5jYXJldERpdi5jbGFzc0xpc3QuYWRkKCdzbWFydC10ZXh0YXJlYS1jYXJldCcpO1xyXG4gICAgICAgIG93bmVyLmFwcGVuZENoaWxkKHRoaXMuY2FyZXREaXYpO1xyXG4gICAgfVxyXG5cclxuICAgIHNob3coKSB7XHJcbiAgICAgICAgY29uc3QgY2FyZXRPZmZzZXQgPSBnZXRDYXJldE9mZnNldEZyb21PZmZzZXRQYXJlbnQodGhpcy50ZXh0QXJlYSk7XHJcbiAgICAgICAgY29uc3Qgc3R5bGUgPSB0aGlzLmNhcmV0RGl2LnN0eWxlO1xyXG4gICAgICAgIHN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xyXG4gICAgICAgIHN0eWxlLnRvcCA9IGNhcmV0T2Zmc2V0LnRvcCArICdweCc7XHJcbiAgICAgICAgc3R5bGUubGVmdCA9IGNhcmV0T2Zmc2V0LmxlZnQgKyAncHgnO1xyXG4gICAgICAgIHN0eWxlLmhlaWdodCA9IGNhcmV0T2Zmc2V0LmhlaWdodCArICdweCc7XHJcbiAgICAgICAgc3R5bGUuekluZGV4ID0gdGhpcy50ZXh0QXJlYS5zdHlsZS56SW5kZXg7XHJcbiAgICAgICAgc3R5bGUuYmFja2dyb3VuZENvbG9yID0gY2FyZXRPZmZzZXQuZWxlbVN0eWxlLmNhcmV0Q29sb3I7XHJcbiAgICB9XHJcblxyXG4gICAgaGlkZSgpIHtcclxuICAgICAgICB0aGlzLmNhcmV0RGl2LnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRQcm9wZXJ0eVJlY3Vyc2l2ZShvYmo6IGFueSwgcHJvcE5hbWU6IHN0cmluZyk6IFByb3BlcnR5RGVzY3JpcHRvciB7XHJcbiAgICB3aGlsZSAob2JqKSB7XHJcbiAgICAgICAgY29uc3QgZGVzY3JpcHRvciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3Iob2JqLCBwcm9wTmFtZSk7XHJcbiAgICAgICAgaWYgKGRlc2NyaXB0b3IpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGRlc2NyaXB0b3I7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG9iaiA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihvYmopO1xyXG4gICAgfVxyXG5cclxuICAgIHRocm93IG5ldyBFcnJvcihgUHJvcGVydHkgJHtwcm9wTmFtZX0gbm90IGZvdW5kIG9uIG9iamVjdCBvciBpdHMgcHJvdG90eXBlIGNoYWluYCk7XHJcbn1cclxuIiwiaW1wb3J0IHsgU3VnZ2VzdGlvbkRpc3BsYXkgfSBmcm9tICcuL1N1Z2dlc3Rpb25EaXNwbGF5JztcclxuaW1wb3J0IHsgU21hcnRUZXh0QXJlYSB9IGZyb20gJy4vU21hcnRUZXh0QXJlYSc7XHJcbmltcG9ydCB7IGdldENhcmV0T2Zmc2V0RnJvbU9mZnNldFBhcmVudCwgaW5zZXJ0VGV4dEF0Q2FyZXRQb3NpdGlvbiwgc2Nyb2xsVGV4dEFyZWFEb3duVG9DYXJldElmTmVlZGVkIH0gZnJvbSAnLi9DYXJldFV0aWwnO1xyXG5cclxuZXhwb3J0IGNsYXNzIE92ZXJsYXlTdWdnZXN0aW9uRGlzcGxheSBpbXBsZW1lbnRzIFN1Z2dlc3Rpb25EaXNwbGF5IHtcclxuICAgIGxhdGVzdFN1Z2dlc3Rpb25UZXh0OiBzdHJpbmcgPSAnJztcclxuICAgIHN1Z2dlc3Rpb25FbGVtZW50OiBIVE1MRGl2RWxlbWVudDtcclxuICAgIHN1Z2dlc3Rpb25QcmVmaXhFbGVtZW50OiBIVE1MU3BhbkVsZW1lbnQ7XHJcbiAgICBzdWdnZXN0aW9uVGV4dEVsZW1lbnQ6IEhUTUxTcGFuRWxlbWVudDtcclxuICAgIHNob3dpbmc6IGJvb2xlYW47XHJcblxyXG4gICAgY29uc3RydWN0b3Iob3duZXI6IFNtYXJ0VGV4dEFyZWEsIHByaXZhdGUgdGV4dEFyZWE6IEhUTUxUZXh0QXJlYUVsZW1lbnQpIHtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uRWxlbWVudC5jbGFzc0xpc3QuYWRkKCdzbWFydC10ZXh0YXJlYS1zdWdnZXN0aW9uLW92ZXJsYXknKTtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIGUgPT4gdGhpcy5oYW5kbGVTdWdnZXN0aW9uQ2xpY2tlZChlKSk7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uRWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIGUgPT4gdGhpcy5oYW5kbGVTdWdnZXN0aW9uQ2xpY2tlZChlKSk7XHJcblxyXG4gICAgICAgIHRoaXMuc3VnZ2VzdGlvblByZWZpeEVsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uVGV4dEVsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uRWxlbWVudC5hcHBlbmRDaGlsZCh0aGlzLnN1Z2dlc3Rpb25QcmVmaXhFbGVtZW50KTtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LmFwcGVuZENoaWxkKHRoaXMuc3VnZ2VzdGlvblRleHRFbGVtZW50KTtcclxuXHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uUHJlZml4RWxlbWVudC5zdHlsZS5vcGFjaXR5ID0gJzAuMyc7XHJcblxyXG4gICAgICAgIGNvbnN0IGNvbXB1dGVkU3R5bGUgPSB3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZSh0aGlzLnRleHRBcmVhKTtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LnN0eWxlLmZvbnQgPSBjb21wdXRlZFN0eWxlLmZvbnQ7XHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uRWxlbWVudC5zdHlsZS5tYXJnaW5Ub3AgPSAocGFyc2VGbG9hdChjb21wdXRlZFN0eWxlLmZvbnRTaXplKSAqIDEuNCkgKyAncHgnO1xyXG5cclxuICAgICAgICBvd25lci5hcHBlbmRDaGlsZCh0aGlzLnN1Z2dlc3Rpb25FbGVtZW50KTtcclxuICAgIH1cclxuXHJcbiAgICBnZXQgY3VycmVudFN1Z2dlc3Rpb24oKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubGF0ZXN0U3VnZ2VzdGlvblRleHQ7XHJcbiAgICB9XHJcblxyXG4gICAgc2hvdyhzdWdnZXN0aW9uOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLmxhdGVzdFN1Z2dlc3Rpb25UZXh0ID0gc3VnZ2VzdGlvbjtcclxuXHJcbiAgICAgICAgdGhpcy5zdWdnZXN0aW9uUHJlZml4RWxlbWVudC50ZXh0Q29udGVudCA9IHN1Z2dlc3Rpb25bMF0gIT0gJyAnID8gZ2V0Q3VycmVudEluY29tcGxldGVXb3JkKHRoaXMudGV4dEFyZWEsIDIwKSA6ICcnO1xyXG4gICAgICAgIHRoaXMuc3VnZ2VzdGlvblRleHRFbGVtZW50LnRleHRDb250ZW50ID0gc3VnZ2VzdGlvbjtcclxuXHJcbiAgICAgICAgY29uc3QgY2FyZXRPZmZzZXQgPSBnZXRDYXJldE9mZnNldEZyb21PZmZzZXRQYXJlbnQodGhpcy50ZXh0QXJlYSk7XHJcbiAgICAgICAgY29uc3Qgc3R5bGUgPSB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LnN0eWxlO1xyXG4gICAgICAgIHN0eWxlLm1pbldpZHRoID0gbnVsbDtcclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LmNsYXNzTGlzdC5hZGQoJ3NtYXJ0LXRleHRhcmVhLXN1Z2dlc3Rpb24tb3ZlcmxheS12aXNpYmxlJyk7XHJcbiAgICAgICAgc3R5bGUuekluZGV4ID0gdGhpcy50ZXh0QXJlYS5zdHlsZS56SW5kZXg7XHJcbiAgICAgICAgc3R5bGUudG9wID0gY2FyZXRPZmZzZXQudG9wICsgJ3B4JztcclxuXHJcbiAgICAgICAgLy8gSWYgdGhlIGhvcml6b250YWwgcG9zaXRpb24gaXMgYWxyZWFkeSBjbG9zZSBlbm91Z2gsIGxlYXZlIGl0IGFsb25lLiBPdGhlcndpc2UgaXRcclxuICAgICAgICAvLyBjYW4gamlnZ2xlIGFubm95aW5nbHkgZHVlIHRvIGluYWNjdXJhY2llcyBpbiBtZWFzdXJpbmcgdGhlIGNhcmV0IHBvc2l0aW9uLlxyXG4gICAgICAgIGNvbnN0IG5ld0xlZnRQb3MgPSBjYXJldE9mZnNldC5sZWZ0IC0gdGhpcy5zdWdnZXN0aW9uUHJlZml4RWxlbWVudC5vZmZzZXRXaWR0aDtcclxuICAgICAgICBpZiAoIXN0eWxlLmxlZnQgfHwgTWF0aC5hYnMocGFyc2VGbG9hdChzdHlsZS5sZWZ0KSAtIG5ld0xlZnRQb3MpID4gMTApIHtcclxuICAgICAgICAgICAgc3R5bGUubGVmdCA9IG5ld0xlZnRQb3MgKyAncHgnO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdGhpcy5zaG93aW5nID0gdHJ1ZTtcclxuXHJcblxyXG4gICAgICAgIC8vIE5vcm1hbGx5IHdlJ3JlIGhhcHB5IGZvciB0aGUgb3ZlcmxheSB0byB0YWtlIHVwIGFzIG11Y2ggd2lkdGggYXMgaXQgY2FuIHVwIHRvIHRoZSBlZGdlIG9mIHRoZSBwYWdlLlxyXG4gICAgICAgIC8vIEhvd2V2ZXIsIGlmIGl0J3MgdG9vIG5hcnJvdyAoYmVjYXVzZSB0aGUgZWRnZSBvZiB0aGUgcGFnZSBpcyBhbHJlYWR5IHRvbyBjbG9zZSksIGl0IHdpbGwgd3JhcCBvbnRvXHJcbiAgICAgICAgLy8gbWFueSBsaW5lcy4gSW4gdGhpcyBjYXNlIHdlJ2xsIGZvcmNlIGl0IHRvIGdldCB3aWRlciwgYW5kIHRoZW4gd2UgaGF2ZSB0byBtb3ZlIGl0IGZ1cnRoZXIgbGVmdCB0b1xyXG4gICAgICAgIC8vIGF2b2lkIHNwaWxsaW5nIG9mZiB0aGUgc2NyZWVuLlxyXG4gICAgICAgIGNvbnN0IHN1Z2dlc3Rpb25Db21wdXRlZFN0eWxlID0gd2luZG93LmdldENvbXB1dGVkU3R5bGUodGhpcy5zdWdnZXN0aW9uRWxlbWVudCk7XHJcbiAgICAgICAgY29uc3QgbnVtTGluZXNPZlRleHQgPSBNYXRoLnJvdW5kKCh0aGlzLnN1Z2dlc3Rpb25FbGVtZW50Lm9mZnNldEhlaWdodCAtIHBhcnNlRmxvYXQoc3VnZ2VzdGlvbkNvbXB1dGVkU3R5bGUucGFkZGluZ1RvcCkgLSBwYXJzZUZsb2F0KHN1Z2dlc3Rpb25Db21wdXRlZFN0eWxlLnBhZGRpbmdCb3R0b20pKVxyXG4gICAgICAgICAgICAvIHBhcnNlRmxvYXQoc3VnZ2VzdGlvbkNvbXB1dGVkU3R5bGUubGluZUhlaWdodCkpO1xyXG4gICAgICAgIGlmIChudW1MaW5lc09mVGV4dCA+IDIpIHtcclxuICAgICAgICAgICAgY29uc3Qgb2xkV2lkdGggPSB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50Lm9mZnNldFdpZHRoO1xyXG4gICAgICAgICAgICBzdHlsZS5taW5XaWR0aCA9IGBjYWxjKG1pbig3MHZ3LCAkeyAobnVtTGluZXNPZlRleHQgKiBvbGRXaWR0aCAvIDIpIH1weCkpYDsgLy8gQWltIGZvciAyIGxpbmVzLCBidXQgZG9uJ3QgZ2V0IHdpZGVyIHRoYW4gNzAlIG9mIHRoZSBzY3JlZW5cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIElmIHRoZSBzdWdnZXN0aW9uIGlzIHRvbyBmYXIgdG8gdGhlIHJpZ2h0LCBtb3ZlIGl0IGxlZnQgc28gaXQncyBub3Qgb2ZmIHRoZSBzY3JlZW5cclxuICAgICAgICBjb25zdCBzdWdnZXN0aW9uQ2xpZW50UmVjdCA9IHRoaXMuc3VnZ2VzdGlvbkVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgaWYgKHN1Z2dlc3Rpb25DbGllbnRSZWN0LnJpZ2h0ID4gZG9jdW1lbnQuYm9keS5jbGllbnRXaWR0aCAtIDIwKSB7XHJcbiAgICAgICAgICAgIHN0eWxlLmxlZnQgPSBgY2FsYygke3BhcnNlRmxvYXQoc3R5bGUubGVmdCkgLSAoc3VnZ2VzdGlvbkNsaWVudFJlY3QucmlnaHQgLSBkb2N1bWVudC5ib2R5LmNsaWVudFdpZHRoKX1weCAtIDJyZW0pYDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgYWNjZXB0KCk6IHZvaWQge1xyXG4gICAgICAgIGlmICghdGhpcy5zaG93aW5nKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGluc2VydFRleHRBdENhcmV0UG9zaXRpb24odGhpcy50ZXh0QXJlYSwgdGhpcy5jdXJyZW50U3VnZ2VzdGlvbik7XHJcblxyXG4gICAgICAgIC8vIFRoZSBuZXdseS1pbnNlcnRlZCB0ZXh0IGNvdWxkIGJlIHNvIGxvbmcgdGhhdCB0aGUgbmV3IGNhcmV0IHBvc2l0aW9uIGlzIG9mZiB0aGUgYm90dG9tIG9mIHRoZSB0ZXh0YXJlYS5cclxuICAgICAgICAvLyBJdCB3b24ndCBzY3JvbGwgdG8gdGhlIG5ldyBjYXJldCBwb3NpdGlvbiBieSBkZWZhdWx0XHJcbiAgICAgICAgc2Nyb2xsVGV4dEFyZWFEb3duVG9DYXJldElmTmVlZGVkKHRoaXMudGV4dEFyZWEpO1xyXG5cclxuICAgICAgICB0aGlzLmhpZGUoKTtcclxuICAgIH1cclxuXHJcbiAgICByZWplY3QoKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy5oaWRlKCk7XHJcbiAgICB9XHJcblxyXG4gICAgaGlkZSgpOiB2b2lkIHtcclxuICAgICAgICBpZiAodGhpcy5zaG93aW5nKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc2hvd2luZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICB0aGlzLnN1Z2dlc3Rpb25FbGVtZW50LmNsYXNzTGlzdC5yZW1vdmUoJ3NtYXJ0LXRleHRhcmVhLXN1Z2dlc3Rpb24tb3ZlcmxheS12aXNpYmxlJyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGlzU2hvd2luZygpOiBib29sZWFuIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5zaG93aW5nO1xyXG4gICAgfVxyXG5cclxuICAgIGhhbmRsZVN1Z2dlc3Rpb25DbGlja2VkKGV2ZW50OiBFdmVudCkge1xyXG4gICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgZXZlbnQuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XHJcbiAgICAgICAgdGhpcy5hY2NlcHQoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0Q3VycmVudEluY29tcGxldGVXb3JkKHRleHRBcmVhOiBIVE1MVGV4dEFyZWFFbGVtZW50LCBtYXhMZW5ndGg6IG51bWJlcikge1xyXG4gICAgY29uc3QgdGV4dCA9IHRleHRBcmVhLnZhbHVlO1xyXG4gICAgY29uc3QgY2FyZXRQb3MgPSB0ZXh0QXJlYS5zZWxlY3Rpb25TdGFydDtcclxuXHJcbiAgICAvLyBOb3QgYWxsIGxhbmd1YWdlcyBoYXZlIHdvcmRzIHNlcGFyYXRlZCBieSBzcGFjZXMuIEltcG9zaW5nIHRoZSBtYXhsZW5ndGggcnVsZVxyXG4gICAgLy8gbWVhbnMgd2UnbGwgbm90IHNob3cgdGhlIHByZWZpeCBmb3IgdGhvc2UgbGFuZ3VhZ2VzIGlmIHlvdSdyZSBpbiB0aGUgbWlkZGxlXHJcbiAgICAvLyBvZiBsb25nZXIgdGV4dCAoYW5kIGVuc3VyZXMgd2UgZG9uJ3Qgc2VhcmNoIHRocm91Z2ggYSBsb25nIGJsb2NrKSwgd2hpY2ggaXMgaWRlYWwuXHJcbiAgICBmb3IgKGxldCBpID0gY2FyZXRQb3MgLSAxOyBpID4gY2FyZXRQb3MgLSBtYXhMZW5ndGg7IGktLSkge1xyXG4gICAgICAgIGlmIChpIDwgMCB8fCB0ZXh0W2ldLm1hdGNoKC9cXHMvKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gdGV4dC5zdWJzdHJpbmcoaSArIDEsIGNhcmV0UG9zKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuICcnO1xyXG59XHJcbiIsImltcG9ydCB7IFN1Z2dlc3Rpb25EaXNwbGF5IH0gZnJvbSAnLi9TdWdnZXN0aW9uRGlzcGxheSc7XHJcbmltcG9ydCB7IElubGluZVN1Z2dlc3Rpb25EaXNwbGF5IH0gZnJvbSAnLi9JbmxpbmVTdWdnZXN0aW9uRGlzcGxheSc7XHJcbmltcG9ydCB7IE92ZXJsYXlTdWdnZXN0aW9uRGlzcGxheSB9IGZyb20gJy4vT3ZlcmxheVN1Z2dlc3Rpb25EaXNwbGF5JztcclxuaW1wb3J0IHsgaW5zZXJ0VGV4dEF0Q2FyZXRQb3NpdGlvbiwgc2Nyb2xsVGV4dEFyZWFEb3duVG9DYXJldElmTmVlZGVkIH0gZnJvbSAnLi9DYXJldFV0aWwnO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU21hcnRUZXh0QXJlYUN1c3RvbUVsZW1lbnQoKSB7XHJcbiAgICBjdXN0b21FbGVtZW50cy5kZWZpbmUoJ3NtYXJ0LXRleHRhcmVhJywgU21hcnRUZXh0QXJlYSk7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBTbWFydFRleHRBcmVhIGV4dGVuZHMgSFRNTEVsZW1lbnQge1xyXG4gICAgdHlwaW5nRGVib3VuY2VUaW1lb3V0OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICAgIHRleHRBcmVhOiBIVE1MVGV4dEFyZWFFbGVtZW50O1xyXG4gICAgc3VnZ2VzdGlvbkRpc3BsYXk6IFN1Z2dlc3Rpb25EaXNwbGF5O1xyXG4gICAgcGVuZGluZ1N1Z2dlc3Rpb25BYm9ydENvbnRyb2xsZXI/OiBBYm9ydENvbnRyb2xsZXI7XHJcblxyXG4gICAgY29ubmVjdGVkQ2FsbGJhY2soKSB7XHJcbiAgICAgICAgaWYgKCEodGhpcy5wcmV2aW91c0VsZW1lbnRTaWJsaW5nIGluc3RhbmNlb2YgSFRNTFRleHRBcmVhRWxlbWVudCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdzbWFydC10ZXh0YXJlYSBtdXN0IGJlIHJlbmRlcmVkIGltbWVkaWF0ZWx5IGFmdGVyIGEgdGV4dGFyZWEgZWxlbWVudCcpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdGhpcy50ZXh0QXJlYSA9IHRoaXMucHJldmlvdXNFbGVtZW50U2libGluZyBhcyBIVE1MVGV4dEFyZWFFbGVtZW50O1xyXG4gICAgICAgIHRoaXMuc3VnZ2VzdGlvbkRpc3BsYXkgPSBzaG91bGRVc2VJbmxpbmVTdWdnZXN0aW9ucyh0aGlzLnRleHRBcmVhKVxyXG4gICAgICAgICAgICA/IG5ldyBJbmxpbmVTdWdnZXN0aW9uRGlzcGxheSh0aGlzLCB0aGlzLnRleHRBcmVhKVxyXG4gICAgICAgICAgICA6IG5ldyBPdmVybGF5U3VnZ2VzdGlvbkRpc3BsYXkodGhpcywgdGhpcy50ZXh0QXJlYSk7XHJcblxyXG4gICAgICAgIHRoaXMudGV4dEFyZWEuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4gdGhpcy5oYW5kbGVLZXlEb3duKGUpKTtcclxuICAgICAgICB0aGlzLnRleHRBcmVhLmFkZEV2ZW50TGlzdGVuZXIoJ2tleXVwJywgZSA9PiB0aGlzLmhhbmRsZUtleVVwKGUpKTtcclxuICAgICAgICB0aGlzLnRleHRBcmVhLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsICgpID0+IHRoaXMucmVtb3ZlRXhpc3RpbmdPclBlbmRpbmdTdWdnZXN0aW9uKCkpO1xyXG4gICAgICAgIHRoaXMudGV4dEFyZWEuYWRkRXZlbnRMaXN0ZW5lcignZm9jdXNvdXQnLCAoKSA9PiB0aGlzLnJlbW92ZUV4aXN0aW5nT3JQZW5kaW5nU3VnZ2VzdGlvbigpKTtcclxuXHJcbiAgICAgICAgLy8gSWYgeW91IHNjcm9sbCwgd2UgZG9uJ3QgbmVlZCB0byBraWxsIGFueSBwZW5kaW5nIHN1Z2dlc3Rpb24gcmVxdWVzdCwgYnV0IHdlIGRvIG5lZWQgdG8gaGlkZVxyXG4gICAgICAgIC8vIGFueSBzdWdnZXN0aW9uIHRoYXQncyBhbHJlYWR5IHZpc2libGUgYmVjYXVzZSB0aGUgZmFrZSBjdXJzb3Igd2lsbCBub3cgYmUgaW4gdGhlIHdyb25nIHBsYWNlXHJcbiAgICAgICAgdGhpcy50ZXh0QXJlYS5hZGRFdmVudExpc3RlbmVyKCdzY3JvbGwnLCAoKSA9PiB0aGlzLnN1Z2dlc3Rpb25EaXNwbGF5LnJlamVjdCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgaGFuZGxlS2V5RG93bihldmVudDogS2V5Ym9hcmRFdmVudCkge1xyXG4gICAgICAgIHN3aXRjaCAoZXZlbnQua2V5KSB7XHJcbiAgICAgICAgICAgIGNhc2UgJ1RhYic6XHJcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5zdWdnZXN0aW9uRGlzcGxheS5pc1Nob3dpbmcoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc3VnZ2VzdGlvbkRpc3BsYXkuYWNjZXB0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlICdBbHQnOlxyXG4gICAgICAgICAgICBjYXNlICdDb250cm9sJzpcclxuICAgICAgICAgICAgY2FzZSAnU2hpZnQnOlxyXG4gICAgICAgICAgICBjYXNlICdDb21tYW5kJzpcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgY29uc3Qga2V5TWF0Y2hlc0V4aXN0aW5nU3VnZ2VzdGlvbiA9IHRoaXMuc3VnZ2VzdGlvbkRpc3BsYXkuaXNTaG93aW5nKClcclxuICAgICAgICAgICAgICAgICAgICAmJiB0aGlzLnN1Z2dlc3Rpb25EaXNwbGF5LmN1cnJlbnRTdWdnZXN0aW9uLnN0YXJ0c1dpdGgoZXZlbnQua2V5KTtcclxuICAgICAgICAgICAgICAgIGlmIChrZXlNYXRjaGVzRXhpc3RpbmdTdWdnZXN0aW9uKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gTGV0IHRoZSB0eXBpbmcgaGFwcGVuLCBidXQgd2l0aG91dCBzaWRlLWVmZmVjdHMgbGlrZSByZW1vdmluZyB0aGUgZXhpc3Rpbmcgc2VsZWN0aW9uXHJcbiAgICAgICAgICAgICAgICAgICAgaW5zZXJ0VGV4dEF0Q2FyZXRQb3NpdGlvbih0aGlzLnRleHRBcmVhLCBldmVudC5rZXkpO1xyXG4gICAgICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIC8vIFVwZGF0ZSB0aGUgZXhpc3Rpbmcgc3VnZ2VzdGlvbiB0byBtYXRjaCB0aGUgbmV3IHRleHRcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLnN1Z2dlc3Rpb25EaXNwbGF5LnNob3codGhpcy5zdWdnZXN0aW9uRGlzcGxheS5jdXJyZW50U3VnZ2VzdGlvbi5zdWJzdHJpbmcoZXZlbnQua2V5Lmxlbmd0aCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIHNjcm9sbFRleHRBcmVhRG93blRvQ2FyZXRJZk5lZWRlZCh0aGlzLnRleHRBcmVhKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5yZW1vdmVFeGlzdGluZ09yUGVuZGluZ1N1Z2dlc3Rpb24oKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBrZXlNYXRjaGVzRXhpc3RpbmdTdWdnZXN0aW9uKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgICAgICAgcmV0dXJuIDtcclxuICAgIH1cclxuXHJcbiAgICAvLyBJZiB0aGlzIHdhcyBjaGFuZ2VkIHRvIGEgJ2tleXByZXNzJyBldmVudCBpbnN0ZWFkLCB3ZSdkIG9ubHkgaW5pdGlhdGUgc3VnZ2VzdGlvbnMgYWZ0ZXJcclxuICAgIC8vIHRoZSB1c2VyIHR5cGVzIGEgdmlzaWJsZSBjaGFyYWN0ZXIsIG5vdCBwcmVzc2luZyBhbm90aGVyIGtleSAoZS5nLiwgYXJyb3dzLCBvciBjdHJsK2MpLlxyXG4gICAgLy8gSG93ZXZlciBmb3Igbm93IEkgdGhpbmsgaXQgaXMgZGVzaXJhYmxlIHRvIHNob3cgc3VnZ2VzdGlvbnMgYWZ0ZXIgY3Vyc29yIG1vdmVtZW50LlxyXG4gICAgaGFuZGxlS2V5VXAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpIHtcclxuICAgICAgICAvLyBJZiBhIHN1Z2dlc3Rpb24gaXMgYWxyZWFkeSB2aXNpYmxlLCBpdCBtdXN0IG1hdGNoIHRoZSBjdXJyZW50IGtleXN0cm9rZSBvciBpdCB3b3VsZFxyXG4gICAgICAgIC8vIGFscmVhZHkgaGF2ZSBiZWVuIHJlbW92ZWQgZHVyaW5nIGtleWRvd24uIFNvIHdlIG9ubHkgc3RhcnQgdGhlIHRpbWVvdXQgcHJvY2VzcyBpZlxyXG4gICAgICAgIC8vIHRoZXJlJ3Mgbm8gdmlzaWJsZSBzdWdnZXN0aW9uLlxyXG4gICAgICAgIGlmICghdGhpcy5zdWdnZXN0aW9uRGlzcGxheS5pc1Nob3dpbmcoKSkge1xyXG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGhpcy50eXBpbmdEZWJvdW5jZVRpbWVvdXQpO1xyXG4gICAgICAgICAgICB0aGlzLnR5cGluZ0RlYm91bmNlVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5oYW5kbGVUeXBpbmdQYXVzZWQoKSwgMzUwKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgaGFuZGxlVHlwaW5nUGF1c2VkKCkge1xyXG4gICAgICAgIGlmIChkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSB0aGlzLnRleHRBcmVhKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIFdlIG9ubHkgc2hvdyBhIHN1Z2dlc3Rpb24gaWYgdGhlIGN1cnNvciBpcyBhdCB0aGUgZW5kIG9mIHRoZSBjdXJyZW50IGxpbmUuIEluc2VydGluZyBzdWdnZXN0aW9ucyBpblxyXG4gICAgICAgIC8vIHRoZSBtaWRkbGUgb2YgYSBsaW5lIGlzIGNvbmZ1c2luZyAodGhpbmdzIG1vdmUgYXJvdW5kIGluIHVudXN1YWwgd2F5cykuXHJcbiAgICAgICAgLy8gVE9ETzogWW91IGNvdWxkIGFsc28gYWxsb3cgdGhlIGNhc2Ugd2hlcmUgYWxsIHJlbWFpbmluZyB0ZXh0IG9uIHRoZSBjdXJyZW50IGxpbmUgaXMgd2hpdGVzcGFjZVxyXG4gICAgICAgIGNvbnN0IGlzQXRFbmRPZkN1cnJlbnRMaW5lID0gdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25TdGFydCA9PT0gdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25FbmRcclxuICAgICAgICAgICAgJiYgKHRoaXMudGV4dEFyZWEuc2VsZWN0aW9uU3RhcnQgPT09IHRoaXMudGV4dEFyZWEudmFsdWUubGVuZ3RoIHx8IHRoaXMudGV4dEFyZWEudmFsdWVbdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25TdGFydF0gPT09ICdcXG4nKTtcclxuICAgICAgICBpZiAoIWlzQXRFbmRPZkN1cnJlbnRMaW5lKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMucmVxdWVzdFN1Z2dlc3Rpb25Bc3luYygpO1xyXG4gICAgfVxyXG5cclxuICAgIHJlbW92ZUV4aXN0aW5nT3JQZW5kaW5nU3VnZ2VzdGlvbigpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQodGhpcy50eXBpbmdEZWJvdW5jZVRpbWVvdXQpO1xyXG5cclxuICAgICAgICB0aGlzLnBlbmRpbmdTdWdnZXN0aW9uQWJvcnRDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgICAgIHRoaXMucGVuZGluZ1N1Z2dlc3Rpb25BYm9ydENvbnRyb2xsZXIgPSBudWxsO1xyXG5cclxuICAgICAgICB0aGlzLnN1Z2dlc3Rpb25EaXNwbGF5LnJlamVjdCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIHJlcXVlc3RTdWdnZXN0aW9uQXN5bmMoKSB7XHJcbiAgICAgICAgdGhpcy5wZW5kaW5nU3VnZ2VzdGlvbkFib3J0Q29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgICAgICB0aGlzLnBlbmRpbmdTdWdnZXN0aW9uQWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG5cclxuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IHtcclxuICAgICAgICAgICAgYWJvcnRTaWduYWw6IHRoaXMucGVuZGluZ1N1Z2dlc3Rpb25BYm9ydENvbnRyb2xsZXIuc2lnbmFsLFxyXG4gICAgICAgICAgICB0ZXh0QXJlYVZhbHVlOiB0aGlzLnRleHRBcmVhLnZhbHVlLFxyXG4gICAgICAgICAgICBjdXJzb3JQb3NpdGlvbjogdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25TdGFydCxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBjb25zdCBib2R5ID0ge1xyXG4gICAgICAgICAgICAvLyBUT0RPOiBMaW1pdCB0aGUgYW1vdW50IG9mIHRleHQgd2Ugc2VuZCwgZS5nLiwgdG8gMTAwIGNoYXJhY3RlcnMgYmVmb3JlIGFuZCBhZnRlciB0aGUgY3Vyc29yXHJcbiAgICAgICAgICAgIHRleHRCZWZvcmU6IHNuYXBzaG90LnRleHRBcmVhVmFsdWUuc3Vic3RyaW5nKDAsIHNuYXBzaG90LmN1cnNvclBvc2l0aW9uKSxcclxuICAgICAgICAgICAgdGV4dEFmdGVyOiBzbmFwc2hvdC50ZXh0QXJlYVZhbHVlLnN1YnN0cmluZyhzbmFwc2hvdC5jdXJzb3JQb3NpdGlvbiksXHJcbiAgICAgICAgICAgIGNvbmZpZzogdGhpcy5nZXRBdHRyaWJ1dGUoJ2RhdGEtY29uZmlnJyksXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgY29uc3QgYW50aWZvcmdlcnlOYW1lID0gdGhpcy5nZXRBdHRyaWJ1dGUoJ2RhdGEtYW50aWZvcmdlcnktbmFtZScpO1xyXG4gICAgICAgIGlmIChhbnRpZm9yZ2VyeU5hbWUpIHtcclxuICAgICAgICAgICAgYm9keVthbnRpZm9yZ2VyeU5hbWVdID0gdGhpcy5nZXRBdHRyaWJ1dGUoJ2RhdGEtYW50aWZvcmdlcnktdmFsdWUnKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RJbml0OiBSZXF1ZXN0SW5pdCA9IHtcclxuICAgICAgICAgICAgbWV0aG9kOiAncG9zdCcsXHJcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgYm9keTogbmV3IFVSTFNlYXJjaFBhcmFtcyhib2R5KSxcclxuICAgICAgICAgICAgc2lnbmFsOiBzbmFwc2hvdC5hYm9ydFNpZ25hbCxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBsZXQgc3VnZ2VzdGlvblRleHQ6IHN0cmluZztcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAvLyBXZSByZWx5IG9uIHRoZSBVUkwgYmVpbmcgcGF0aGJhc2UtcmVsYXRpdmUgZm9yIEJsYXpvciwgb3IgYSB+Ly4uLiBVUkwgdGhhdCB3b3VsZCBhbHJlYWR5XHJcbiAgICAgICAgICAgIC8vIGJlIHJlc29sdmVkIG9uIHRoZSBzZXJ2ZXIgZm9yIE1WQ1xyXG4gICAgICAgICAgICBjb25zdCBodHRwUmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh0aGlzLmdldEF0dHJpYnV0ZSgnZGF0YS11cmwnKSwgcmVxdWVzdEluaXQpO1xyXG4gICAgICAgICAgICBzdWdnZXN0aW9uVGV4dCA9IGh0dHBSZXNwb25zZS5vayA/IGF3YWl0IGh0dHBSZXNwb25zZS50ZXh0KCkgOiBudWxsO1xyXG4gICAgICAgIH0gY2F0Y2ggKGV4KSB7XHJcbiAgICAgICAgICAgIGlmIChleCBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiBleC5uYW1lID09PSAnQWJvcnRFcnJvcicpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gTm9ybWFsbHkgaWYgdGhlIHVzZXIgaGFzIG1hZGUgZnVydGhlciBlZGl0cyBpbiB0aGUgdGV4dGFyZWEsIG91ciBIVFRQIHJlcXVlc3Qgd291bGQgYWxyZWFkeVxyXG4gICAgICAgIC8vIGhhdmUgYmVlbiBhYm9ydGVkIHNvIHdlIHdvdWxkbid0IGdldCBoZXJlLiBCdXQgaWYgc29tZXRoaW5nIGVsc2UgKGUuZy4sIHNvbWUgb3RoZXIgSlMgY29kZSlcclxuICAgICAgICAvLyBtdXRhdGVzIHRoZSB0ZXh0YXJlYSwgd2Ugd291bGQgc3RpbGwgZ2V0IGhlcmUuIEl0J3MgaW1wb3J0YW50IHdlIGRvbid0IGFwcGx5IHRoZSBzdWdnZXN0aW9uXHJcbiAgICAgICAgLy8gaWYgdGhlIHRleHRhcmVhIHZhbHVlIG9yIGN1cnNvciBwb3NpdGlvbiBoYXMgY2hhbmdlZCwgc28gY29tcGFyZSBhZ2FpbnN0IG91ciBzbmFwc2hvdC5cclxuICAgICAgICBpZiAoc3VnZ2VzdGlvblRleHRcclxuICAgICAgICAgICAgJiYgc25hcHNob3QudGV4dEFyZWFWYWx1ZSA9PT0gdGhpcy50ZXh0QXJlYS52YWx1ZVxyXG4gICAgICAgICAgICAmJiBzbmFwc2hvdC5jdXJzb3JQb3NpdGlvbiA9PT0gdGhpcy50ZXh0QXJlYS5zZWxlY3Rpb25TdGFydCkge1xyXG4gICAgICAgICAgICBpZiAoIXN1Z2dlc3Rpb25UZXh0LmVuZHNXaXRoKCcgJykpIHtcclxuICAgICAgICAgICAgICAgIHN1Z2dlc3Rpb25UZXh0ICs9ICcgJztcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgdGhpcy5zdWdnZXN0aW9uRGlzcGxheS5zaG93KHN1Z2dlc3Rpb25UZXh0KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNob3VsZFVzZUlubGluZVN1Z2dlc3Rpb25zKHRleHRBcmVhOiBIVE1MVGV4dEFyZWFFbGVtZW50KTogYm9vbGVhbiB7XHJcbiAgICAvLyBBbGxvdyB0aGUgZGV2ZWxvcGVyIHRvIHNwZWNpZnkgdGhpcyBleHBsaWNpdGx5IGlmIHRoZXkgd2FudFxyXG4gICAgY29uc3QgZXhwbGljaXRDb25maWcgPSB0ZXh0QXJlYS5nZXRBdHRyaWJ1dGUoJ2RhdGEtaW5saW5lLXN1Z2dlc3Rpb25zJyk7XHJcbiAgICBpZiAoZXhwbGljaXRDb25maWcpIHtcclxuICAgICAgICByZXR1cm4gZXhwbGljaXRDb25maWcudG9Mb3dlckNhc2UoKSA9PT0gJ3RydWUnO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIC4uLiBidXQgYnkgZGVmYXVsdCwgd2UgdXNlIG92ZXJsYXkgb24gdG91Y2ggZGV2aWNlcywgaW5saW5lIG9uIG5vbi10b3VjaCBkZXZpY2VzXHJcbiAgICAvLyBUaGF0J3MgYmVjYXVzZTpcclxuICAgIC8vICAtIE1vYmlsZSBkZXZpY2VzIHdpbGwgYmUgdG91Y2gsIGFuZCBtb3N0IG1vYmlsZSB1c2VycyBkb24ndCBoYXZlIGEgXCJ0YWJcIiBrZXkgYnkgd2hpY2ggdG8gYWNjZXB0IGlubGluZSBzdWdnZXN0aW9uc1xyXG4gICAgLy8gIC0gTW9iaWxlIGRldmljZXMgc3VjaCBhcyBpT1Mgd2lsbCBkaXNwbGF5IGFsbCBraW5kcyBvZiBleHRyYSBVSSBhcm91bmQgc2VsZWN0ZWQgdGV4dCAoZS5nLiwgc2VsZWN0aW9uIGhhbmRsZXMpLFxyXG4gICAgLy8gICAgd2hpY2ggd291bGQgbG9vayBjb21wbGV0ZWx5IHdyb25nXHJcbiAgICAvLyBJbiBnZW5lcmFsLCB0aGUgb3ZlcmxheSBhcHByb2FjaCBpcyB0aGUgcmlzay1hdmVyc2Ugb25lIHRoYXQgd29ya3MgZXZlcnl3aGVyZSwgZXZlbiB0aG91Z2ggaXQncyBub3QgYXMgYXR0cmFjdGl2ZS5cclxuICAgIGNvbnN0IGlzVG91Y2ggPSAnb250b3VjaHN0YXJ0JyBpbiB3aW5kb3c7IC8vIFRydWUgZm9yIGFueSBtb2JpbGUuIFVzdWFsbHkgbm90IHRydWUgZm9yIGRlc2t0b3AuXHJcbiAgICByZXR1cm4gIWlzVG91Y2g7XHJcbn1cclxuIiwiaW1wb3J0IHsgcmVnaXN0ZXJTbWFydENvbWJvQm94Q3VzdG9tRWxlbWVudCB9IGZyb20gJy4vU21hcnRDb21ib0JveCc7XHJcbmltcG9ydCB7IHJlZ2lzdGVyU21hcnRQYXN0ZUNsaWNrSGFuZGxlciB9IGZyb20gJy4vU21hcnRQYXN0ZSc7XHJcbmltcG9ydCB7IHJlZ2lzdGVyU21hcnRUZXh0QXJlYUN1c3RvbUVsZW1lbnQgfSBmcm9tICcuL1NtYXJ0VGV4dEFyZWEvU21hcnRUZXh0QXJlYSc7XHJcblxyXG4vLyBPbmx5IHJ1biB0aGlzIHNjcmlwdCBvbmNlLiBJZiB5b3UgaW1wb3J0IGl0IG11bHRpcGxlIHRpbWVzLCB0aGUgMm5kLWFuZC1sYXRlciBhcmUgbm8tb3BzLlxyXG5jb25zdCBpc0xvYWRlZE1hcmtlciA9ICdfX3NtYXJ0X2NvbXBvbmVudHNfbG9hZGVkX18nO1xyXG5pZiAoIU9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoZG9jdW1lbnQsIGlzTG9hZGVkTWFya2VyKSkge1xyXG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGRvY3VtZW50LCBpc0xvYWRlZE1hcmtlciwgeyBlbnVtZXJhYmxlOiBmYWxzZSwgd3JpdGFibGU6IGZhbHNlIH0pO1xyXG5cclxuICAgIHJlZ2lzdGVyU21hcnRDb21ib0JveEN1c3RvbUVsZW1lbnQoKTtcclxuICAgIHJlZ2lzdGVyU21hcnRQYXN0ZUNsaWNrSGFuZGxlcigpO1xyXG4gICAgcmVnaXN0ZXJTbWFydFRleHRBcmVhQ3VzdG9tRWxlbWVudCgpO1xyXG59XHJcbiJdLCJuYW1lcyI6WyJjYXJldFBvcy5wb3NpdGlvbiJdLCJtYXBwaW5ncyI6IkFB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
