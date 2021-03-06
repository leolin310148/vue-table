(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var Vue // late bind
var map = Object.create(null)
var shimmed = false
var isBrowserify = false

/**
 * Determine compatibility and apply patch.
 *
 * @param {Function} vue
 * @param {Boolean} browserify
 */

exports.install = function (vue, browserify) {
  if (shimmed) return
  shimmed = true

  Vue = vue
  isBrowserify = browserify

  exports.compatible = !!Vue.internalDirectives
  if (!exports.compatible) {
    console.warn(
      '[HMR] vue-loader hot reload is only compatible with ' +
      'Vue.js 1.0.0+.'
    )
    return
  }

  // patch view directive
  patchView(Vue.internalDirectives.component)
  console.log('[HMR] Vue component hot reload shim applied.')
  // shim router-view if present
  var routerView = Vue.elementDirective('router-view')
  if (routerView) {
    patchView(routerView)
    console.log('[HMR] vue-router <router-view> hot reload shim applied.')
  }
}

/**
 * Shim the view directive (component or router-view).
 *
 * @param {Object} View
 */

function patchView (View) {
  var unbuild = View.unbuild
  View.unbuild = function (defer) {
    if (!this.hotUpdating) {
      var prevComponent = this.childVM && this.childVM.constructor
      removeView(prevComponent, this)
      // defer = true means we are transitioning to a new
      // Component. Register this new component to the list.
      if (defer) {
        addView(this.Component, this)
      }
    }
    // call original
    return unbuild.call(this, defer)
  }
}

/**
 * Add a component view to a Component's hot list
 *
 * @param {Function} Component
 * @param {Directive} view - view directive instance
 */

function addView (Component, view) {
  var id = Component && Component.options.hotID
  if (id) {
    if (!map[id]) {
      map[id] = {
        Component: Component,
        views: [],
        instances: []
      }
    }
    map[id].views.push(view)
  }
}

/**
 * Remove a component view from a Component's hot list
 *
 * @param {Function} Component
 * @param {Directive} view - view directive instance
 */

function removeView (Component, view) {
  var id = Component && Component.options.hotID
  if (id) {
    map[id].views.$remove(view)
  }
}

/**
 * Create a record for a hot module, which keeps track of its construcotr,
 * instnaces and views (component directives or router-views).
 *
 * @param {String} id
 * @param {Object} options
 */

exports.createRecord = function (id, options) {
  if (typeof options === 'function') {
    options = options.options
  }
  if (typeof options.el !== 'string' && typeof options.data !== 'object') {
    makeOptionsHot(id, options)
    map[id] = {
      Component: null,
      views: [],
      instances: []
    }
  }
}

/**
 * Make a Component options object hot.
 *
 * @param {String} id
 * @param {Object} options
 */

function makeOptionsHot (id, options) {
  options.hotID = id
  injectHook(options, 'created', function () {
    var record = map[id]
    if (!record.Component) {
      record.Component = this.constructor
    }
    record.instances.push(this)
  })
  injectHook(options, 'beforeDestroy', function () {
    map[id].instances.$remove(this)
  })
}

/**
 * Inject a hook to a hot reloadable component so that
 * we can keep track of it.
 *
 * @param {Object} options
 * @param {String} name
 * @param {Function} hook
 */

function injectHook (options, name, hook) {
  var existing = options[name]
  options[name] = existing
    ? Array.isArray(existing)
      ? existing.concat(hook)
      : [existing, hook]
    : [hook]
}

/**
 * Update a hot component.
 *
 * @param {String} id
 * @param {Object|null} newOptions
 * @param {String|null} newTemplate
 */

exports.update = function (id, newOptions, newTemplate) {
  var record = map[id]
  // force full-reload if an instance of the component is active but is not
  // managed by a view
  if (!record || (record.instances.length && !record.views.length)) {
    console.log('[HMR] Root or manually-mounted instance modified. Full reload may be required.')
    if (!isBrowserify) {
      window.location.reload()
    } else {
      // browserify-hmr somehow sends incomplete bundle if we reload here
      return
    }
  }
  if (!isBrowserify) {
    // browserify-hmr already logs this
    console.log('[HMR] Updating component: ' + format(id))
  }
  var Component = record.Component
  // update constructor
  if (newOptions) {
    // in case the user exports a constructor
    Component = record.Component = typeof newOptions === 'function'
      ? newOptions
      : Vue.extend(newOptions)
    makeOptionsHot(id, Component.options)
  }
  if (newTemplate) {
    Component.options.template = newTemplate
  }
  // handle recursive lookup
  if (Component.options.name) {
    Component.options.components[Component.options.name] = Component
  }
  // reset constructor cached linker
  Component.linker = null
  // reload all views
  record.views.forEach(function (view) {
    updateView(view, Component)
  })
  // flush devtools
  if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
    window.__VUE_DEVTOOLS_GLOBAL_HOOK__.emit('flush')
  }
}

/**
 * Update a component view instance
 *
 * @param {Directive} view
 * @param {Function} Component
 */

function updateView (view, Component) {
  if (!view._bound) {
    return
  }
  view.Component = Component
  view.hotUpdating = true
  // disable transitions
  view.vm._isCompiled = false
  // save state
  var state = extractState(view.childVM)
  // remount, make sure to disable keep-alive
  var keepAlive = view.keepAlive
  view.keepAlive = false
  view.mountComponent()
  view.keepAlive = keepAlive
  // restore state
  restoreState(view.childVM, state, true)
  // re-eanble transitions
  view.vm._isCompiled = true
  view.hotUpdating = false
}

/**
 * Extract state from a Vue instance.
 *
 * @param {Vue} vm
 * @return {Object}
 */

function extractState (vm) {
  return {
    cid: vm.constructor.cid,
    data: vm.$data,
    children: vm.$children.map(extractState)
  }
}

/**
 * Restore state to a reloaded Vue instance.
 *
 * @param {Vue} vm
 * @param {Object} state
 */

function restoreState (vm, state, isRoot) {
  var oldAsyncConfig
  if (isRoot) {
    // set Vue into sync mode during state rehydration
    oldAsyncConfig = Vue.config.async
    Vue.config.async = false
  }
  // actual restore
  if (isRoot || !vm._props) {
    vm.$data = state.data
  } else {
    Object.keys(state.data).forEach(function (key) {
      if (!vm._props[key]) {
        // for non-root, only restore non-props fields
        vm.$data[key] = state.data[key]
      }
    })
  }
  // verify child consistency
  var hasSameChildren = vm.$children.every(function (c, i) {
    return state.children[i] && state.children[i].cid === c.constructor.cid
  })
  if (hasSameChildren) {
    // rehydrate children
    vm.$children.forEach(function (c, i) {
      restoreState(c, state.children[i])
    })
  }
  if (isRoot) {
    Vue.config.async = oldAsyncConfig
  }
}

function format (id) {
  return id.match(/[^\/]+\.vue$/)[0]
}

},{}],2:[function(require,module,exports){
var inserted = exports.cache = {}

exports.insert = function (css) {
  if (inserted[css]) return
  inserted[css] = true

  var elem = document.createElement('style')
  elem.setAttribute('type', 'text/css')

  if ('textContent' in elem) {
    elem.textContent = css
  } else {
    elem.styleSheet.cssText = css
  }

  document.getElementsByTagName('head')[0].appendChild(elem)
  return elem
}

},{}],3:[function(require,module,exports){
var __vueify_insert__ = require("vueify/lib/insert-css")
var __vueify_style__ = __vueify_insert__.insert("\n.vuetable th.sortable:hover {\n  color: #2185d0;\n  cursor: pointer;\n}\n.vuetable-actions {\n  width: 15%;\n  padding: 12px 0px;\n  text-align: center;\n}\n.vuetable-pagination {\n  background: #f9fafb !important;\n}\n.vuetable-pagination-info {\n  margin-top: auto;\n  margin-bottom: auto;\n}\n")
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = {
    props: {
        'wrapperClass': {
            type: String,
            default: function _default() {
                return null;
            }
        },
        'tableWrapper': {
            type: String,
            default: function _default() {
                return null;
            }
        },
        'tableClass': {
            type: String,
            default: function _default() {
                return 'ui blue striped selectable celled stackable attached table';
            }
        },
        'loadingClass': {
            type: String,
            default: function _default() {
                return 'loading';
            }
        },
        'dataPath': {
            type: String,
            default: function _default() {
                return 'data';
            }
        },
        'paginationPath': {
            type: String,
            default: function _default() {
                return 'links.pagination';
            }
        },
        'fields': {
            type: Array,
            required: true
        },
        'apiUrl': {
            type: String,
            required: true
        },
        'sortOrder': {
            type: Object,
            default: function _default() {
                return {
                    field: '',
                    direction: 'asc'
                };
            }
        },
        'perPage': {
            type: Number,
            coerce: function coerce(val) {
                return parseInt(val);
            },
            default: function _default() {
                return 10;
            }
        },
        'ascendingIcon': {
            type: String,
            default: function _default() {
                return 'blue chevron up icon';
            }
        },
        'descendingIcon': {
            type: String,
            default: function _default() {
                return 'blue chevron down icon';
            }
        },
        'appendParams': {
            type: Array,
            default: function _default() {
                return [];
            }
        },
        'showPagination': {
            type: Boolean,
            default: function _default() {
                return true;
            }
        },
        'paginationComponent': {
            type: String,
            default: function _default() {
                return 'vuetable-pagination';
            }
        },
        'paginationInfoTemplate': {
            type: String,
            default: function _default() {
                return "Displaying {from} to {to} of {total} items";
            }
        },
        'paginationInfoNoDataTemplate': {
            type: String,
            default: function _default() {
                return 'No relevant data';
            }
        },
        'paginationClass': {
            type: String,
            default: function _default() {
                return 'ui bottom attached segment grid';
            }
        },
        'paginationInfoClass': {
            type: String,
            default: function _default() {
                return 'left floated left aligned six wide column';
            }
        },
        'paginationComponentClass': {
            type: String,
            default: function _default() {
                return 'right floated right aligned six wide column';
            }
        },
        'paginationConfig': {
            type: String,
            default: function _default() {
                return 'paginationConfig';
            }
        },
        itemActions: {
            type: Array,
            default: function _default() {
                return [];
            }
        },
        queryParams: {
            type: Object,
            default: function _default() {
                return {
                    sort: 'sort',
                    page: 'page',
                    perPage: 'per_page'
                };
            }
        },
        loadOnStart: {
            type: Boolean,
            default: function _default() {
                return true;
            }
        },
        selectedTo: {
            type: Array,
            default: function _default() {
                return [];
            }
        },
        httpData: {
            type: Object,
            default: function _default() {
                return {};
            }
        },
        httpOptions: {
            type: Object,
            default: function _default() {
                return {};
            }
        }
    },
    data: function data() {
        return {
            version: '1.1.1',
            eventPrefix: 'vuetable:',
            tableData: null,
            tablePagination: null,
            currentPage: 1
        };
    },
    directives: {
        'attr': {
            update: function update(value) {
                for (var i in value) {
                    this.el.setAttribute(i, value[i]);
                }
            }
        }
    },
    computed: {
        sortIcon: function sortIcon() {
            return this.sortOrder.direction == 'asc' ? this.ascendingIcon : this.descendingIcon;
        },
        paginationInfo: function paginationInfo() {
            if (this.tablePagination == null || this.tablePagination.total == 0) {
                return this.paginationInfoNoDataTemplate;
            }

            return this.paginationInfoTemplate.replace('{from}', this.tablePagination.from || 0).replace('{to}', this.tablePagination.to || 0).replace('{total}', this.tablePagination.total || 0);
        }
    },
    methods: {
        normalizeFields: function normalizeFields() {
            var self = this;
            var obj;
            this.fields.forEach(function (field, i) {
                if (typeof field === 'string') {
                    obj = {
                        name: field,
                        title: self.setTitle(field),
                        titleClass: '',
                        dataClass: '',
                        callback: null,
                        visible: true
                    };
                } else {
                    obj = {
                        name: field.name,
                        title: field.title === undefined ? self.setTitle(field.name) : field.title,
                        sortField: field.sortField,
                        titleClass: field.titleClass === undefined ? '' : field.titleClass,
                        dataClass: field.dataClass === undefined ? '' : field.dataClass,
                        callback: field.callback === undefined ? '' : field.callback,
                        visible: field.visible === undefined ? true : field.visible
                    };
                }
                self.fields.$set(i, obj);
            });
        },
        setTitle: function setTitle(str) {
            if (this.isSpecialField(str)) {
                return '';
            }

            return this.titleCase(str);
        },
        titleCase: function titleCase(str) {
            return str.replace(/\w+/g, function (txt) {
                return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
            });
        },
        loadData: function loadData() {
            var wrapper = document.querySelector(this.tableWrapper);
            this.showLoadingAnimation(wrapper);

            var params = [this.queryParams.sort + '=' + this.getSortParam(), this.queryParams.page + '=' + this.currentPage, this.queryParams.perPage + '=' + this.perPage];

            var url = this.apiUrl + '?' + params.join('&');
            if (this.appendParams.length > 0) {
                url += '&' + this.appendParams.join('&');
            }
            var self = this;
            this.$http.get(url, this.httpData, this.httpOptions).then(function (response) {
                self.tableData = self.getObjectValue(response.data, self.dataPath, null);
                self.tablePagination = self.getObjectValue(response.data, self.paginationPath, null);
                if (self.tablePagination === null) {
                    console.warn('vuetable: pagination-path "' + self.paginationPath + '"" not found. ' + 'It looks like the data returned from the sever does not have pagination information.');
                }

                self.dispatchEvent('load-success', response);
                self.broadcastEvent('load-success', self.tablePagination);

                self.hideLoadingAnimation(wrapper);
            }, function (response) {
                self.dispatchEvent('load-error', response);
                self.broadcastEvent('load-error', response);

                self.hideLoadingAnimation(wrapper);
            });
        },
        showLoadingAnimation: function showLoadingAnimation(wrapper) {
            if (wrapper !== null) {
                this.addClass(wrapper, this.loadingClass);
            }
            this.dispatchEvent('loading');
        },
        hideLoadingAnimation: function hideLoadingAnimation(wrapper) {
            if (wrapper !== null) {
                this.removeClass(wrapper, this.loadingClass);
            }
            this.dispatchEvent('loaded');
        },
        getTitle: function getTitle(field) {
            if (typeof field.title === 'undefined') {
                return field.name.replace('.', ' ');
            }
            return field.title;
        },
        getSortParam: function getSortParam() {
            if (!this.sortOrder || this.sortOrder.field == '') {
                return '';
            }

            var fieldName = typeof this.sortOrder.sortField === 'undefined' ? this.sortOrder.field : this.sortOrder.sortField;

            return fieldName + '|' + this.sortOrder.direction;
        },
        addClass: function addClass(el, className) {
            if (el.classList) el.classList.add(className);else el.className += ' ' + className;
        },
        removeClass: function removeClass(el, className) {
            if (el.classList) el.classList.remove(className);else el.className = el.className.replace(new RegExp('(^|\\b)' + className.split(' ').join('|') + '(\\b|$)', 'gi'), ' ');
        },
        dispatchEvent: function dispatchEvent(eventName, args) {
            this.$dispatch(this.eventPrefix + eventName, args);
        },
        broadcastEvent: function broadcastEvent(eventName, args) {
            this.$broadcast(this.eventPrefix + eventName, args);
        },
        orderBy: function orderBy(field) {
            if (!this.isSortable(field)) {
                return;
            }

            if (this.sortOrder.field == field.name) {
                // change sort direction
                this.sortOrder.direction = this.sortOrder.direction == 'asc' ? 'desc' : 'asc';
            } else {
                // reset sort direction
                this.sortOrder.direction = 'asc';
            }
            this.sortOrder.field = field.name;
            this.sortOrder.sortField = field.sortField;
            this.currentPage = 1; // reset page index
            this.loadData();
        },
        isSortable: function isSortable(field) {
            return !(typeof field.sortField == 'undefined');
        },
        isCurrentSortField: function isCurrentSortField(field) {
            if (!this.isSortable(field)) {
                return false;
            }

            return this.sortOrder.field == field.name;
        },
        gotoPreviousPage: function gotoPreviousPage() {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadData();
            }
        },
        gotoNextPage: function gotoNextPage() {
            if (this.currentPage < this.tablePagination.last_page) {
                this.currentPage++;
                this.loadData();
            }
        },
        gotoPage: function gotoPage(page) {
            if (page != this.currentPage && page > 0 && page <= this.tablePagination.last_page) {
                this.currentPage = page;
                this.loadData();
            }
        },
        isSpecialField: function isSpecialField(fieldName) {
            return fieldName.startsWith('__');
        },
        hasCallback: function hasCallback(item) {
            return item.callback ? true : false;
        },
        callCallback: function callCallback(field, item) {
            if (!this.hasCallback(field)) return;

            var args = field.callback.split('|');
            var func = args.shift();

            if (typeof this.$parent[func] == 'function') {
                return args.length > 0 ? this.$parent[func].apply(this.$parent, [this.getObjectValue(item, field.name)].concat(args)) : this.$parent[func].call(this.$parent, this.getObjectValue(item, field.name));
            }

            return null;
        },
        getObjectValue: function getObjectValue(object, path, defaultValue) {
            defaultValue = typeof defaultValue == 'undefined' ? null : defaultValue;

            var obj = object;
            if (path.trim() != '') {
                var keys = path.split('.');
                keys.forEach(function (key) {
                    if (typeof obj[key] != 'undefined' && obj[key] !== null) {
                        obj = obj[key];
                    } else {
                        obj = defaultValue;
                        return;
                    }
                });
            }
            return obj;
        },
        callAction: function callAction(action, data) {
            this.$dispatch(this.eventPrefix + 'action', action, data);
        },
        addParam: function addParam(param) {
            this.appendParams.push(param);
        },
        toggleCheckbox: function toggleCheckbox(isChecked, dataItem, fieldName) {
            var idColumn = this.extractArgs(fieldName);
            if (idColumn === undefined) {
                console.warn('You did not provide reference id column with "__checkbox:<column_name>" field!');
                return;
            }
            if (isChecked) {
                this.selectedTo.push(dataItem[idColumn]);
            } else {
                this.selectedTo.$remove(dataItem[idColumn]);
            }
        },
        toggleAllCheckboxes: function toggleAllCheckboxes(isChecked, fieldName) {
            var self = this;
            var idColumn = this.extractArgs(fieldName);

            if (isChecked) {
                this.tableData.forEach(function (dataItem) {
                    if (!self.isSelectedRow(dataItem, fieldName)) {
                        self.selectedTo.push(dataItem[idColumn]);
                    }
                });
            } else {
                this.tableData.forEach(function (dataItem) {
                    self.selectedTo.$remove(dataItem[idColumn]);
                });
            }
        },
        isSelectedRow: function isSelectedRow(dataItem, fieldName) {
            return this.selectedTo.indexOf(dataItem[this.extractArgs(fieldName)]) >= 0;
        },
        extractName: function extractName(string) {
            return string.split(':')[0].trim();
        },
        extractArgs: function extractArgs(string) {
            return string.split(':')[1];
        },
        onRowChanged: function onRowChanged(dataItem) {
            this.dispatchEvent('row-changed', dataItem);
            return true;
        },
        onRowClicked: function onRowClicked(dataItem, event) {
            this.$dispatch(this.eventPrefix + 'row-clicked', dataItem, event);
            return true;
        },
        onCellDoubleClicked: function onCellDoubleClicked(dataItem, field, event) {
            this.$dispatch(this.eventPrefix + 'cell-dblclicked', dataItem, field, event);
        },
        callPaginationConfig: function callPaginationConfig() {
            if (typeof this.$parent[this.paginationConfig] === 'function') {
                this.$parent[this.paginationConfig].call(this.$parent, this.$refs.pagination.$options.name);
            }
        }
    },
    events: {
        'vuetable-pagination:change-page': function vuetablePaginationChangePage(page) {
            if (page == 'prev') {
                this.gotoPreviousPage();
            } else if (page == 'next') {
                this.gotoNextPage();
            } else {
                this.gotoPage(page);
            }
        },
        'vuetable:reload': function vuetableReload() {
            this.loadData();
        },
        'vuetable:refresh': function vuetableRefresh() {
            this.currentPage = 1;
            this.loadData();
        },
        'vuetable:goto-page': function vuetableGotoPage(page) {
            this.$emit('vuetable-pagination:change-page', page);
        },
        'vuetable:set-options': function vuetableSetOptions(options) {
            for (var n in options) {
                this.$set(n, options[n]);
            }
        }
    },
    created: function created() {
        this.normalizeFields();
        if (this.loadOnStart) {
            this.loadData();
        }
        this.$nextTick(function () {
            this.callPaginationConfig();
        });
    }
};
if (module.exports.__esModule) module.exports = module.exports.default
;(typeof module.exports === "function"? module.exports.options: module.exports).template = "\n<div class=\"{{wrapperClass}}\">\n    <table class=\"vuetable {{tableClass}}\">\n        <thead>\n            <tr>\n                <template v-for=\"field in fields\">\n                    <template v-if=\"field.visible\">\n                        <template v-if=\"isSpecialField(field.name)\">\n                            <th v-if=\"extractName(field.name) == '__checkbox'\" class=\"{{field.titleClass || ''}}\">\n                                <input type=\"checkbox\" @change=\"toggleAllCheckboxes($event.target.checked, field.name)\">\n                            </th>\n                            <th v-else=\"\" id=\"{{field.name}}\" class=\"{{field.titleClass || ''}}\">\n                                {{field.title || ''}}\n                            </th>\n                        </template>\n                        <template v-else=\"\">\n                            <th @click=\"orderBy(field)\" id=\"_{{field.name}}\" class=\"{{field.titleClass || ''}} {{isSortable(field) ? 'sortable' : ''}}\">\n                                {{getTitle(field) | capitalize}}&nbsp;\n                                <i v-if=\"isCurrentSortField(field)\" class=\"{{ sortIcon }}\"></i>\n                            </th>\n                        </template>\n                    </template>\n                </template>\n            </tr>\n        </thead>\n        <tbody v-cloak=\"\">\n            <tr v-for=\"(itemNumber, item) in tableData\" @click=\"onRowClicked(item, $event)\">\n                <template v-if=\"onRowChanged(item)\"></template>\n                <template v-for=\"field in fields\">\n                    <template v-if=\"field.visible\">\n                        <template v-if=\"isSpecialField(field.name)\">\n                            <td v-if=\"extractName(field.name) == '__sequence'\" class=\"vuetable-sequence {{field.dataClass}}\" v-html=\"tablePagination.from + itemNumber\">\n                            </td>\n                            <td v-if=\"extractName(field.name) == '__checkbox'\" class=\"vuetable-checkboxes {{field.dataClass}}\">\n                                <input type=\"checkbox\" @change=\"toggleCheckbox($event.target.checked, item, field.name)\" :checked=\"isSelectedRow(item, field.name)\">\n                            </td>\n                            <td v-if=\"field.name == '__actions'\" class=\"vuetable-actions {{field.dataClass}}\">\n                                <template v-for=\"action in itemActions\">\n                                    <button class=\"{{ action.class }}\" @click=\"callAction(action.name, item)\" v-attr=\"action.extra\">\n                                        <i class=\"{{ action.icon }}\"></i> {{ action.label }}\n                                    </button>\n                                </template>\n                            </td>\n                        </template>\n                        <template v-else=\"\">\n                            <td v-if=\"hasCallback(field)\" class=\"{{field.dataClass}}\" @dblclick=\"onCellDoubleClicked(item, field, $event)\">\n                                {{{ callCallback(field, item) }}}\n                            </td>\n                            <td v-else=\"\" class=\"{{field.dataClass}}\" @dblclick=\"onCellDoubleClicked(item, field, $event)\">\n                                {{{ getObjectValue(item, field.name, \"\") }}}\n                            </td>\n                        </template>\n                    </template>\n                </template>\n            </tr>\n        </tbody>\n    </table>\n    <div v-if=\"showPagination\" class=\"vuetable-pagination {{paginationClass}}\">\n        <div class=\"vuetable-pagination-info {{paginationInfoClass}}\" v-html=\"paginationInfo\">\n        </div>\n        <div v-show=\"tablePagination &amp;&amp; tablePagination.last_page > 1\" class=\"vuetable-pagination-component {{paginationComponentClass}}\">\n            <component v-ref:pagination=\"\" :is=\"paginationComponent\"></component>\n        </div>\n    </div>\n</div>\n"
if (module.hot) {(function () {  module.hot.accept()
  var hotAPI = require("vue-hot-reload-api")
  hotAPI.install(require("vue"), true)
  if (!hotAPI.compatible) return
  module.hot.dispose(function () {
    __vueify_insert__.cache["\n.vuetable th.sortable:hover {\n  color: #2185d0;\n  cursor: pointer;\n}\n.vuetable-actions {\n  width: 15%;\n  padding: 12px 0px;\n  text-align: center;\n}\n.vuetable-pagination {\n  background: #f9fafb !important;\n}\n.vuetable-pagination-info {\n  margin-top: auto;\n  margin-bottom: auto;\n}\n"] = false
    document.head.removeChild(__vueify_style__)
  })
  if (!module.hot.data) {
    hotAPI.createRecord("_v-2018f0d5", module.exports)
  } else {
    hotAPI.update("_v-2018f0d5", module.exports, (typeof module.exports === "function" ? module.exports.options : module.exports).template)
  }
})()}
},{"vue":"vue","vue-hot-reload-api":1,"vueify/lib/insert-css":2}],4:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});

var _VuetablePaginationMixin = require('./VuetablePaginationMixin.vue');

var _VuetablePaginationMixin2 = _interopRequireDefault(_VuetablePaginationMixin);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = {
    mixins: [_VuetablePaginationMixin2.default]
};
if (module.exports.__esModule) module.exports = module.exports.default
;(typeof module.exports === "function"? module.exports.options: module.exports).template = "\n<div class=\"{{wrapperClass}}\">\n    <a @click=\"loadPage(1)\" class=\"btn-nav {{linkClass}} {{isOnFirstPage ? disabledClass : ''}}\">\n            <i v-if=\"icons.first != ''\" class=\"{{icons.first}}\"></i>\n            <span v-else=\"\">«</span>\n    </a>\n    <a @click=\"loadPage('prev')\" class=\"btn-nav {{linkClass}} {{isOnFirstPage ? disabledClass : ''}}\">\n            <i v-if=\"icons.next != ''\" class=\"{{icons.prev}}\"></i>\n            <span v-else=\"\">&nbsp;‹</span>\n    </a>\n    <template v-if=\"notEnoughPages\">\n        <template v-for=\"n in totalPage\">\n            <a @click=\"loadPage(n+1)\" class=\"{{pageClass}} {{isCurrentPage(n+1) ? activeClass : ''}}\">\n                    {{ n+1 }}\n            </a>\n        </template>\n    </template>\n    <template v-else=\"\">\n       <template v-for=\"n in windowSize\">\n           <a @click=\"loadPage(windowStart+n)\" class=\"{{pageClass}} {{isCurrentPage(windowStart+n) ? activeClass : ''}}\">\n                {{ windowStart+n }}\n           </a>\n       </template>\n    </template>\n    <a @click=\"loadPage('next')\" class=\"btn-nav {{linkClass}} {{isOnLastPage ? disabledClass : ''}}\">\n        <i v-if=\"icons.next != ''\" class=\"{{icons.next}}\"></i>\n        <span v-else=\"\">›&nbsp;</span>\n    </a>\n    <a @click=\"loadPage(totalPage)\" class=\"btn-nav {{linkClass}} {{isOnLastPage ? disabledClass : ''}}\">\n        <i v-if=\"icons.last != ''\" class=\"{{icons.last}}\"></i>\n        <span v-else=\"\">»</span>\n    </a>\n</div>\n"
if (module.hot) {(function () {  module.hot.accept()
  var hotAPI = require("vue-hot-reload-api")
  hotAPI.install(require("vue"), true)
  if (!hotAPI.compatible) return
  if (!module.hot.data) {
    hotAPI.createRecord("_v-3008af4f", module.exports)
  } else {
    hotAPI.update("_v-3008af4f", module.exports, (typeof module.exports === "function" ? module.exports.options : module.exports).template)
  }
})()}
},{"./VuetablePaginationMixin.vue":6,"vue":"vue","vue-hot-reload-api":1}],5:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});

var _VuetablePaginationMixin = require('./VuetablePaginationMixin.vue');

var _VuetablePaginationMixin2 = _interopRequireDefault(_VuetablePaginationMixin);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = {
    mixins: [_VuetablePaginationMixin2.default],
    props: {
        'dropdownClass': {
            type: String,
            default: function _default() {
                return 'ui search dropdown';
            }
        },
        'pageText': {
            type: String,
            default: function _default() {
                return 'Page';
            }
        }
    },
    methods: {
        loadPage: function loadPage(page) {
            // update dropdown value
            if (page == 'prev' && !this.isOnFirstPage) {
                this.setDropdownToPage(this.tablePagination.current_page - 1);
            } else if (page == 'next' && !this.isOnLastPage) {
                this.setDropdownToPage(this.tablePagination.current_page + 1);
            }

            this.$dispatch('vuetable-pagination:change-page', page);
        },
        setDropdownToPage: function setDropdownToPage(page) {
            this.$nextTick(function () {
                document.getElementById('vuetable-pagination-dropdown').value = page;
            });
        },
        selectPage: function selectPage(event) {
            this.$dispatch('vuetable-pagination:change-page', event.target.selectedIndex + 1);
        }
    },
    events: {
        'vuetable:load-success': function vuetableLoadSuccess(tablePagination) {
            this.tablePagination = tablePagination;
            this.setDropdownToPage(tablePagination.current_page);
        }
    }
};
if (module.exports.__esModule) module.exports = module.exports.default
;(typeof module.exports === "function"? module.exports.options: module.exports).template = "\n<div class=\"{{wrapperClass}}\">\n    <a @click=\"loadPage('prev')\" class=\"{{linkClass}} {{isOnFirstPage ? disabledClass : ''}}\">\n        <i :class=\"icons.prev\"></i>\n    </a>\n    <select id=\"vuetable-pagination-dropdown\" class=\"{{dropdownClass}}\" @change=\"selectPage($event)\">\n        <template v-for=\"n in totalPage\">\n            <option class=\"{{pageClass}}\" value=\"{{n+1}}\">\n                {{pageText}} {{n+1}}\n            </option>\n        </template>\n    </select>\n    <a @click=\"loadPage('next')\" class=\"{{linkClass}} {{isOnLastPage ? disabledClass : ''}}\">\n        <i :class=\"icons.next\"></i>\n    </a>\n</div>\n"
if (module.hot) {(function () {  module.hot.accept()
  var hotAPI = require("vue-hot-reload-api")
  hotAPI.install(require("vue"), true)
  if (!hotAPI.compatible) return
  if (!module.hot.data) {
    hotAPI.createRecord("_v-fe1fa000", module.exports)
  } else {
    hotAPI.update("_v-fe1fa000", module.exports, (typeof module.exports === "function" ? module.exports.options : module.exports).template)
  }
})()}
},{"./VuetablePaginationMixin.vue":6,"vue":"vue","vue-hot-reload-api":1}],6:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = {
    props: {
        'wrapperClass': {
            type: String,
            default: function _default() {
                return 'ui right floated pagination menu';
            }
        },
        'activeClass': {
            type: String,
            default: function _default() {
                return 'active large';
            }
        },
        'disabledClass': {
            type: String,
            default: function _default() {
                return 'disabled';
            }
        },
        'pageClass': {
            type: String,
            default: function _default() {
                return 'item';
            }
        },
        'linkClass': {
            type: String,
            default: function _default() {
                return 'icon item';
            }
        },
        'icons': {
            type: Object,
            default: function _default() {
                return {
                    first: 'angle double left icon',
                    prev: 'left chevron icon',
                    next: 'right chevron icon',
                    last: 'angle double right icon'
                };
            }
        },
        'onEachSide': {
            type: Number,
            coerce: function coerce(value) {
                return parseInt(value);
            },
            default: function _default() {
                return 2;
            }
        }
    },
    data: function data() {
        return {
            tablePagination: null
        };
    },
    computed: {
        totalPage: function totalPage() {
            return this.tablePagination == null ? 0 : this.tablePagination.last_page;
        },
        isOnFirstPage: function isOnFirstPage() {
            return this.tablePagination == null ? false : this.tablePagination.current_page == 1;
        },
        isOnLastPage: function isOnLastPage() {
            return this.tablePagination == null ? false : this.tablePagination.current_page == this.tablePagination.last_page;
        },
        notEnoughPages: function notEnoughPages() {
            return this.totalPage < this.onEachSide * 2 + 4;
        },
        windowSize: function windowSize() {
            return this.onEachSide * 2 + 1;
        },
        windowStart: function windowStart() {
            if (this.tablePagination.current_page <= this.onEachSide) {
                return 1;
            } else if (this.tablePagination.current_page >= this.totalPage - this.onEachSide) {
                return this.totalPage - this.onEachSide * 2;
            }

            return this.tablePagination.current_page - this.onEachSide;
        }
    },
    methods: {
        loadPage: function loadPage(page) {
            this.$dispatch('vuetable-pagination:change-page', page);
        },
        isCurrentPage: function isCurrentPage(page) {
            return page == this.tablePagination.current_page;
        }
    },
    events: {
        'vuetable:load-success': function vuetableLoadSuccess(tablePagination) {
            this.tablePagination = tablePagination;
        },
        'vuetable-pagination:set-options': function vuetablePaginationSetOptions(options) {
            for (var n in options) {
                this.$set(n, options[n]);
            }
        }
    }
};
if (module.exports.__esModule) module.exports = module.exports.default
if (module.hot) {(function () {  module.hot.accept()
  var hotAPI = require("vue-hot-reload-api")
  hotAPI.install(require("vue"), true)
  if (!hotAPI.compatible) return
  if (!module.hot.data) {
    hotAPI.createRecord("_v-15609422", module.exports)
  } else {
    hotAPI.update("_v-15609422", module.exports, (typeof module.exports === "function" ? module.exports.options : module.exports).template)
  }
})()}
},{"vue":"vue","vue-hot-reload-api":1}],7:[function(require,module,exports){
Vue.component('vuetable-pagination', require('./components/VuetablePagination.vue'));

Vue.component('vuetable-pagination-dropdown', require('./components/VuetablePaginationDropdown.vue'));

Vue.component('vuetable', require('./components/Vuetable.vue'));
},{"./components/Vuetable.vue":3,"./components/VuetablePagination.vue":4,"./components/VuetablePaginationDropdown.vue":5}]},{},[7]);
