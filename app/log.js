// vim: ts=4:sw=4:expandtab
/* global */

(function () {
    'use strict';

    self.F = self.F || {};
    const ns = F.log = {};

    const tagStyles = {
        blue: 'color: blue',
        red: 'color: red',
        yellow: 'color: yellow',
        green: 'color: green',
        pink: 'color: pink',
        b: 'font-weight: bold',
        u: 'font-decoration: underline',
        i: 'font-style: italic',
        sans: 'font-family: sans',
        mini: 'font-size: 0.5em',
        tiny: 'font-size: 0.7em',
        small: 'font-size: 0.85em',
        large: 'font-size: 1.15em',
        big: 'font-size: 1.33em',
        huge: 'font-size: 2em',
        massive: 'font-size: 4em',
    };

    function formatter(logMarkup) {
        if (!self.document) {
            // ServiceWorker...
            return [logMarkup.replace(/(<([^>]+)>)/ig, ''), []];
        }
        const rootEl = document.createElement('root');
        rootEl.innerHTML = logMarkup;
        let el = rootEl;
        const format = [];
        const styles = [];
        const styleStack = [];
        function parseElement(el) {
            for (const node of el.childNodes) {
                if (node instanceof Text) {
                    format.push(node.nodeValue);
                } else if (node instanceof Element) {
                    const nodeName = node.nodeName.toLowerCase();
                    const style = tagStyles[nodeName];
                    if (style) {
                        format.push('%c');
                        styleStack.push(style);
                        styles.push(styleStack.join(';'));
                    }
                    parseElement(node);
                    if (style) {
                        format.push('%c');
                        styleStack.length--;
                        styles.push(styleStack.join(';'));
                    }
                }
            }
        }
        parseElement(el);
        return [format.join(''), styles];
    }

    function makeLogFunc(consoleFunc, markup, ...args) {
        const [format, styles] = formatter(markup);
        return consoleFunc.bind(console, format, ...styles, ...args);
    }


    ns.debug = function() {
        return makeLogFunc(console.debug, ...arguments)();
    };

    ns.info = function() {
        return makeLogFunc(console.info, ...arguments)();
    };

    ns.warn = function() {
        return makeLogFunc(console.warn, ...arguments)();
    };

    ns.error = function() {
        return makeLogFunc(console.error, ...arguments)();
    };


    const _loggers = new Map();
    const _levels = {
        'debug': 10,
        'info': 20,
        'warn': 30,
        'error': 30
    };

    ns.Logger = class Logger {
        constructor(name, options) {
            options = options || {};
            this.name = name;
            this.setLevel(options.level || 'info');
        }

        setLevel(label) {
            const level = _levels[label];
            if (level == null) {
                throw new Error("Invalid level");
            }
            this._level = level;
        }

        debug() {
            if (this._level <= _levels['debug']) {
                return this._makeLogFunc(console.debug, ...arguments)();
            }
        }

        info() {
            if (this._level <= _levels['info']) {
                return this._makeLogFunc(console.info, ...arguments)();
            }
        }

        warn() {
            if (this._level <= _levels['warn']) {
                return this._makeLogFunc(console.warn, ...arguments)();
            }
        }

        error() {
            if (this._level <= _levels['error']) {
                return this._makeLogFunc(console.error, ...arguments)();
            }
        }

        _makeLogFunc(logFunc, markup, ...args) {
            return makeLogFunc(logFunc, `<b>[${this.name}]</b> ${markup}`, ...args);
        }
    };

    ns.getLogger = function(name, options) {
        if (!_loggers.has(name)) {
            _loggers.set(name, new ns.Logger(name, options));
        }
        return _loggers.get(name);
    };
})();
