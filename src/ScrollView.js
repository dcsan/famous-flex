/**
 * This Source Code is licensed under the MIT license. If a copy of the
 * MIT-license was not distributed with this file, You can obtain one at:
 * http://opensource.org/licenses/mit-license.html.
 *
 * @author: Hein Rutjes (IjzerenHein)
 * @license MIT
 * @copyright Gloey Apps, 2014
 */

/*global define, console*/
/*eslint no-use-before-define:0, no-console:0 */

/**
 * Work in progress - do not use.
 *
 * Inherited from: [FlowLayoutController](./FlowLayoutController.md)
 * @module
 */
define(function(require, exports, module) {

    // import dependencies
    //var LayoutUtility = require('./LayoutUtility');
    var FlowLayoutController = require('./FlowLayoutController');
    var FlowLayoutNode = require('./FlowLayoutNode');
    var LayoutNodeManager = require('./LayoutNodeManager');
    var ContainerSurface = require('famous/surfaces/ContainerSurface');
    var Transform = require('famous/core/Transform');
    var EventHandler = require('famous/core/EventHandler');
    var Group = require('famous/core/Group');
    var Vector = require('famous/math/Vector');
    var PhysicsEngine = require('famous/physics/PhysicsEngine');
    var Particle = require('famous/physics/bodies/Particle');
    var Drag = require('famous/physics/forces/Drag');
    var Spring = require('famous/physics/forces/Spring');
    var ScrollSync = require('famous/inputs/ScrollSync');

    /**
     * Boudary reached detection
     */
    var Bounds = {
        NONE: 0,
        PREV: 1, // top
        NEXT: 2, // bottom
        BOTH: 3
    };

    /**
     * Source of the spring
     */
    var SpringSource = {
        NONE: 'none',
        NEXTBOUNDS: 'next-bounds', // top
        PREVBOUNDS: 'prev-bounds', // bottom
        MINSIZE: 'minimal-size',
        GOTOSEQUENCE: 'goto-sequence',
        GOTOPREVDIRECTION: 'goto-prev-direction',
        GOTONEXTDIRECTION: 'goto-next-direction',
        SNAPPREV: 'snap-prev', // paginated: true
        SNAPNEXT: 'snap-next'  // paginated: true
    };

    /**
     * @class
     * @param {Object} options Options.
     * @alias module:ScrollView
     */
    function ScrollView(options, createNodeFn) {
        FlowLayoutController.call(this, ScrollView.DEFAULT_OPTIONS, new LayoutNodeManager(FlowLayoutNode, _initLayoutNode.bind(this)));
        if (options) {
            this.setOptions(options);
        }

        // Scrolling
        this._scroll = {
            activeTouches: [],
            // physics-engine to use for scrolling
            pe: new PhysicsEngine(),
            // particle that represents the scroll-offset
            particle: new Particle({
                position: [0, 0]
            }),
            // drag-force that slows the particle down after a "flick"
            dragForce: new Drag(this.options.scrollDrag),
            // spring
            springValue: undefined,
            springForce: new Spring(this.options.scrollSpring),
            springEndState: new Vector([0, 0, 0]),
            // group
            groupStart: 0,
            // delta
            scrollDelta: 0,
            normalizedScrollDelta: 0,
            scrollForce: 0,
            scrollForceCount: 0
        };

        // Diagnostics
        this._debug = {
            layoutCount: 0
        };

        // Create groupt for faster rendering
        this.group = new Group();
        this.group.add({render: _innerRender.bind(this)});

        // Configure physics engine with particle and drag
        this._scroll.pe.addBody(this._scroll.particle);
        this._scroll.dragForceId = this._scroll.pe.attach(this._scroll.dragForce, this._scroll.particle);
        this._scroll.springForce.setOptions({ anchor: this._scroll.springEndState });

        // Setup input event handler
        this._eventInput = new EventHandler();
        EventHandler.setInputHandler(this, this._eventInput);

        // Listen to touch events
        this._eventInput.on('touchstart', _touchStart.bind(this));
        this._eventInput.on('touchmove', _touchMove.bind(this));
        this._eventInput.on('touchend', _touchEnd.bind(this));
        this._eventInput.on('touchcancel', _touchEnd.bind(this));

        // Listen to mouse-wheel events
        this._scrollSync = new ScrollSync(this.options.scrollSync);
        this._eventInput.pipe(this._scrollSync);
        //this._scrollSync.on('start', _moveStart.bind(this, this._scrollSync));
        this._scrollSync.on('update', _scrollUpdate.bind(this));
        //this._scrollSync.on('end', _moveEnd.bind(this, this._scrollSync));

        // Embed in container surface if neccesary
        if (this.options.useContainer) {
            this.container = new ContainerSurface({
                properties: {overflow : 'hidden'}
            });

            // Create container surface, which has one child, which just returns
            // the entity-id of this scrollview. This causes the Commit function
            // of this scrollview to be called
            this.container.add({
                render: function() {
                    return this.id;
                }.bind(this)
            });

            // Pipe events received in container to this scrollview
            this.subscribe(this.container);
            EventHandler.setInputHandler(this.container, this);
            EventHandler.setOutputHandler(this.container, this);
        }
    }
    ScrollView.prototype = Object.create(FlowLayoutController.prototype);
    ScrollView.prototype.constructor = ScrollView;
    ScrollView.Bounds = Bounds;

    ScrollView.DEFAULT_OPTIONS = {
        //insertSpec: undefined,
        //removeSpec: undefined,
        useContainer: false,
        offsetRounding: 1.0,
        scrollDrag: {
            strength : 0.001
        },
        scrollSpring: {
            dampingRatio: 1.0,
            period: 500
        },
        scrollSync: {
            scale: 0.1
        },
        paginated: false,
        //paginationEnergyThresshold: 0.001,
        reverse: false,
        touchMoveDirectionThresshold: undefined, // 0..1
        logging: true,
        scrollCallback: undefined //function(offset, force)
    };

    var oldSetOptions = ScrollView.prototype.setOptions;
    /**
     * Patches the ScrollView instance's options with the passed-in ones.
     *
     * @param {Options} options An object of configurable options for the FlowLayoutController instance.
     * @param {Function|Object} [options.layout] Layout function or layout-literal.
     * @param {Object} [options.layoutOptions] Options to pass in to the layout-function.
     * @param {Array|ViewSequence|Object} [options.dataSource] Array, ViewSequence or Object with key/value pairs.
     * @param {Utility.Direction} [options.direction] Direction to layout into (e.g. Utility.Direction.Y) (when ommited the default direction of the layout is used)
     * @param {Spec} [options.insertSpec] Size, transform, opacity... to use when inserting new renderables into the scene.
     * @param {Spec} [options.removeSpec] Size, transform, opacity... to use when removing renderables from the scene.
     * @param {Object} [options.nodeSpring] Spring options to use when transitioning between states
     * @return {FlowLayoutController} this
     */
    ScrollView.prototype.setOptions = function(options) {
        oldSetOptions.call(this, options);
        // todo - all other options
        return this;
    };

    /**
     * Called whenever a layout-node is created/re-used. Initializes
     * the node with the `insertSpec` if it has been defined and enabled
     * locking of the x/y translation so that the x/y position of the renderable
     * is immediately updated when the user scrolls the view.
     */
    function _initLayoutNode(node, spec) {
        /*if (node.setOptions) {
            node.setOptions({
                spring: this.options.nodeSpring
            });
        }*/
        if (!spec && this.options.insertSpec) {
            node.setSpec(this.options.insertSpec);
        }
        if (node.setDirectionLock) {
            node.setDirectionLock(this._direction, 1);
        }
    }

    /**
     * Helper function for logging debug statements to the console.
     */
    function _log(args) {
        if (!this.options.logging) {
            return;
        }
        var message = this._debug.layoutCount + ': ';
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            if ((arg instanceof Object) || (arg instanceof Array)) {
                message += JSON.stringify(arg);
            }
            else {
                message += arg;
            }
        }
        console.log(message);
    }

    /**
     * Helper function to aid development and find bugs.
     */
    function _verifyIntegrity(phase, scrollOffset) {
        /*phase = phase ? ' (' + phase + ')' : '';
        if ((scrollOffset !== undefined) && isNaN(scrollOffset)) {
            throw 'invalid scrollOffset: ' + scrollOffset + phase;
        }
        if (isNaN(this._scroll.particle.getVelocity1D(0))) {
            throw 'invalid particle velocity: ' + this._scroll.particle.getVelocity1D(0) + phase;
        }
        if (isNaN(this._scroll.particle.getPosition1D(0))) {
            throw 'invalid particle position: ' + this._scroll.particle.getPosition1D(0) + phase;
        }*/
    }

    /**
     * Sets the value for the spring, or set to `undefined` to disable the spring
     */
    function _updateSpring() {
        var springValue = this._scroll.scrollForceCount ? undefined : this._scroll.springPosition;
        if (springValue !== undefined) {
            springValue = _roundScrollOffset.call(this, springValue);
        }
        if (this._scroll.springValue !== springValue) {
            this._scroll.springValue = springValue;
            if (springValue === undefined) {
                if (this._scroll.springForceId !== undefined) {
                    this._scroll.pe.detach(this._scroll.springForceId);
                    this._scroll.springForceId = undefined;
                    _log.call(this, 'disabled spring');
                }
            }
            else {
                if (this._scroll.springForceId === undefined) {
                    this._scroll.springForceId = this._scroll.pe.attach(this._scroll.springForce, this._scroll.particle);
                }
                this._scroll.springEndState.set1D(springValue);
                this._scroll.pe.wake();
                _log.call(this, 'setting spring to: ', springValue, ' (', this._scroll.springSource, ')');
            }
        }
    }

    /**
     * Called whenever the user starts moving the scroll-view, using
     * touch gestures.
     */
    function _touchStart(event) {
        //_log.call(this, 'touchStart');
        //this._eventOutput.emit('touchstart', event);

        // Remove any touches that are no longer active
        var oldTouchesCount = this._scroll.activeTouches.length;
        var i = 0;
        var touchFound;
        while (i < this._scroll.activeTouches.length) {
            var activeTouch = this._scroll.activeTouches[i];
            touchFound = false;
            for (var j = 0; j < event.touches.length; j++) {
                var touch = event.touches[j];
                if (touch.identifier === activeTouch.id) {
                    touchFound = true;
                    break;
                }
            }
            if (!touchFound) {
                //_log.cal(this, 'removing touch with id: ', activeTouch.id);
                this._scroll.activeTouches.splice(i, 1);
            }
            else {
                i++;
            }
        }

        // Process touch
        for (i = 0; i < event.touches.length; i++) {
            var changedTouch = event.touches[i];
            touchFound = false;
            for (j = 0; j < this._scroll.activeTouches.length; i++) {
                if (this._scroll.activeTouches[j].id === changedTouch.identifier) {
                    touchFound = true;
                    break;
                }
            }
            if (!touchFound) {
                var current = [changedTouch.clientX, changedTouch.clientY];
                var time = Date.now();
                this._scroll.activeTouches.push({
                    id: changedTouch.identifier,
                    start: current,
                    current: current,
                    prev: current,
                    time: time,
                    prevTime: time
                });
            }
        }

        // The first time a touch new touch gesture has arrived, emit event
        if (!oldTouchesCount && this._scroll.activeTouches.length) {
            this.applyScrollForce(0);
            this._scroll.touchDelta = 0;
            if (this.options.scrollCallback) {
                this.options.scrollCallback(0, 1);
            }
            //this._eventOutput.emit('scrollstart', this._scroll.activeTouches[0]);
        }
    }

    /**
     * Called whenever the user is moving his/her fingers to scroll the view.
     * Updates the moveOffset so that the scroll-offset on the view is updated.
     */
    function _touchMove(event) {
        //_log.call(this, 'touchMove');
        //this._eventOutput.emit('touchmove', event);

        // Process the touch event
        var primaryTouch;
        for (var i = 0; i < event.changedTouches.length; i++) {
            var changedTouch = event.changedTouches[i];
            for (var j = 0; j < this._scroll.activeTouches.length; j++) {
                var touch = this._scroll.activeTouches[j];
                if (touch.id === changedTouch.identifier) {

                    // When a thresshold is configured, check whether the move operation (x/y ratio)
                    // lies within the thresshold. A move of 10 pixels x and 10 pixels y is considered 45 deg,
                    // which corresponds to a thresshold of 0.5.
                    var moveDirection = Math.atan2(
                        Math.abs(changedTouch.clientY - touch.prev[1]),
                        Math.abs(changedTouch.clientX - touch.prev[0])) / (Math.PI / 2.0);
                    var directionDiff = Math.abs(this._direction - moveDirection);
                    if ((this.options.touchMoveDirectionThresshold === undefined) || (directionDiff <= this.options.touchMoveDirectionThresshold)){
                        touch.prev = touch.current;
                        touch.current = [changedTouch.clientX, changedTouch.clientY];
                        touch.prevTime = touch.time;
                        touch.direction = moveDirection;
                        touch.time = Date.now();
                        primaryTouch = (j === 0) ? touch : undefined;
                    }
                }
            }
        }

        // Update move offset and emit event
        if (primaryTouch) {
            var delta = primaryTouch.current[this._direction] - primaryTouch.start[this._direction];
            if (this.options.scrollCallback) {
                delta = this.options.scrollCallback(delta, 2);
            }
            this.updateScrollForce(this._scroll.touchDelta, delta);
            this._scroll.touchDelta = delta;
            //this._eventOutput.emit('scrollmove', this._scroll.activeTouches[0]);
        }
    }

    /**
     * Called whenever the user releases his fingers and the touch gesture
     * has completed. This will set the new position and if the user used a 'flick'
     * gesture give the scroll-offset particle a velocity and momentum into a
     * certain direction.
     */
    function _touchEnd(event) {
        //_log.call(this, 'touchEnd');
        //this._eventOutput.emit('touchend', event);

        // Remove touch
        var primaryTouch = this._scroll.activeTouches.length ? this._scroll.activeTouches[0] : undefined;
        for (var i = 0; i < event.changedTouches.length; i++) {
            var changedTouch = event.changedTouches[i];
            for (var j = 0; j < this._scroll.activeTouches.length; j++) {
                var touch = this._scroll.activeTouches[j];
                if (touch.id === changedTouch.identifier) {

                    // Remove touch
                    this._scroll.activeTouches.splice(j, 1);

                    // When a different touch now becomes the primary touch, update
                    // its start position to match the current move offset.
                    if ((j === 0) && this._scroll.activeTouches.length) {
                        var newPrimaryTouch = this._scroll.activeTouches[0];
                        newPrimaryTouch.start[0] = newPrimaryTouch.current[0] - (touch.current[0] - touch.start[0]);
                        newPrimaryTouch.start[1] = newPrimaryTouch.current[1] - (touch.current[1] - touch.start[1]);
                    }
                    break;
                }
            }
        }

        // Wait for all fingers to be released from the screen before resetting the move-spring
        if (this._scroll.activeTouches.length) {
            return;
        }

        // Determine velocity and add to particle
        var velocity = 0;
        var diffTime = Date.now() - primaryTouch.prevTime;
        if (diffTime > 0) {
            var diffOffset = primaryTouch.current[this._direction] - primaryTouch.prev[this._direction];
            velocity = diffOffset / diffTime;
        }

        // Execute callback
        var delta = this._scroll.touchDelta;
        if (this.options.scrollCallback) {
            delta = this.options.scrollCallback(delta, 3, velocity);
        }

        // Release scroll force
        this.releaseScrollForce(delta, velocity);
        this._scroll.touchDelta = 0;

        // Emit end event
        //this._eventOutput.emit('scrollend', primaryTouch);
    }

    /**
     * Called whenever the user is scrolling the view using either a mouse
     * scroll wheel or a track-pad.
     */
    function _scrollUpdate(event) {
        var offset = Array.isArray(event.delta) ? event.delta[this._direction] : event.delta;
        if (this.options.scrollCallback) {
            offset = this.options.scrollCallback(offset, 0);
        }
        this.scroll(offset);
    }

    /**
     * Helper function which rounds the scroll-offset to ensure it reaches an end-state and doesn't
     * move infinitely.
     */
    function _roundScrollOffset(scrollOffset) {
        return Math.round(scrollOffset / this.options.offsetRounding) * this.options.offsetRounding;
    }

    /**
     * Updates the scroll offset particle.
     */
    function _setParticle(position, velocity, phase) {
        if (position !== undefined) {
            var oldPosition = this._scroll.particle.getPosition1D();
            this._scroll.particle.setPosition1D(position);
            _log.call(this, 'setParticle.position: ', position, ' (old: ', oldPosition, ', delta: ', position - oldPosition, ', phase: ', phase, ')');
        }
        if (velocity !== undefined) {
            var oldVelocity = this._scroll.particle.getVelocity1D();
            if (oldVelocity !== velocity) {
                this._scroll.particle.setVelocity1D(velocity);
                _log.call(this, 'setParticle.velocity: ', velocity, ' (old: ', oldVelocity, ', delta: ', velocity - oldVelocity, ', phase: ', phase, ')');
            }
        }
    }

    /**
     * Get the in-use scroll-offset.
     */
    function _calcScrollOffset(normalize) {

        // When moving using touch-gestures, make the offset stick to the
        // finger. When the bounds is exceeded, decrease the scroll distance
        // by two.
        var scrollOffset = this._scroll.particle.getPosition1D();

        if (this._scroll.scrollDelta || this._scroll.normalizedScrollDelta) {
            scrollOffset += this._scroll.scrollDelta + this._scroll.normalizedScrollDelta;
            if (((this._scroll.boundsReached & Bounds.PREV) && (scrollOffset > this._scroll.springPosition)) ||
               ((this._scroll.boundsReached & Bounds.NEXT) && (scrollOffset < this._scroll.springPosition)) ||
               (this._scroll.boundsReached === Bounds.BOTH)) {
                scrollOffset = this._scroll.springPosition;
            }
            if (normalize) {
                if (!this._scroll.scrollDelta) {
                    this._scroll.normalizedScrollDelta = 0;
                    _setParticle.call(this, scrollOffset, undefined, '_calcScrollOffset');
                }
                this._scroll.normalizedScrollDelta += this._scroll.scrollDelta;
                this._scroll.scrollDelta = 0;
            }
        }

        if (this._scroll.scrollForceCount) {
            if (this._scroll.springPosition !== undefined) {
                scrollOffset = (scrollOffset + this._scroll.scrollForce + this._scroll.springPosition) / 2.0;
            }
            else {
                scrollOffset += this._scroll.scrollForce;
            }
        }

        //_log.call(this, 'scrollOffset: ', scrollOffset, ', particle:', this._scroll.particle.getPosition1D(), ', moveToPosition: ', this._scroll.moveToPosition, ', springPosition: ', this._scroll.springPosition);
        return _roundScrollOffset.call(this, scrollOffset);
    }

    /**
     * Helper function that calculates the next/prev layed out height.
     */
    function _calcHeight(next) {
        var height = 0;
        this._nodes.forEach(function(node) {
            if ((node.scrollLength === undefined) || node.trueSizeRequested) {
                height = undefined; // can't determine height
                return true;
            }
            height += node.scrollLength;
        }.bind(this), next);
        return height;
    }

    /**
     * Normalizes the scroll-offset so that scroll-offset is as close
     * to 0 as can be. This function modifies the scrollOffset and the
     * viewSeuqnce so that the least possible view-sequence nodes
     * need to be rendered.
     *
     * I.e., when the scroll-offset is changed, e.g. by scrolling up
     * or down, then renderables may end-up outside the visible range.
     */
    function _calcBounds(size, scrollOffset) {

        // Local data
        var prevHeight;
        var nextHeight;

        // 1. Check whether primary boundary has been reached
        if (this.options.reverse) {
            nextHeight = _calcHeight.call(this, true);
            prevHeight = _calcHeight.call(this, false);
            if ((nextHeight !== undefined) && ((scrollOffset + nextHeight) <= 0)) {
                this._scroll.boundsReached = Bounds.NEXT;
                this._scroll.springPosition = -nextHeight;
                this._scroll.springSource = SpringSource.NEXTBOUNDS;
                return;
            }
        }
        else {
            prevHeight = _calcHeight.call(this, false);
            if ((prevHeight !== undefined) && ((scrollOffset - prevHeight) >= 0)) {
                this._scroll.boundsReached = Bounds.PREV;
                this._scroll.springPosition = prevHeight;
                this._scroll.springSource = SpringSource.PREVBOUNDS;
                return;
            }
            nextHeight = _calcHeight.call(this, true);
        }

        // 2. When the rendered height is smaller than the total height,
        //    then lock to the primary bounds
        var totalHeight;
        if ((nextHeight !== undefined) && (prevHeight !== undefined)) {
            totalHeight = prevHeight + nextHeight;
        }
        if ((totalHeight !== undefined) && (totalHeight <= size[this._direction])) {
            this._scroll.boundsReached = Bounds.BOTH;
            this._scroll.springPosition = this.options.reverse ? -nextHeight : prevHeight;
            this._scroll.springSource = SpringSource.MINSIZE;
            return;
        }

        // 3. Check if secondary bounds has been reached
        if (this.options.reverse) {
            if ((prevHeight !== undefined) && ((scrollOffset - prevHeight) >= -size[this._direction])) {
                this._scroll.boundsReached = Bounds.PREV;
                this._scroll.springPosition = -size[this._direction] + prevHeight;
                this._scroll.springSource = SpringSource.PREVBOUNDS;
                return;
            }
        }
        else {
            if ((nextHeight !== undefined) && ((scrollOffset + nextHeight) <= size[this._direction])){
                this._scroll.boundsReached = Bounds.NEXT;
                this._scroll.springPosition = size[this._direction] - nextHeight;
                this._scroll.springSource = SpringSource.NEXTBOUNDS;
                return;

            }
        }

        // No bounds reached
        this._scroll.boundsReached = Bounds.NONE;
        this._scroll.springPosition = undefined;
        this._scroll.springSource = SpringSource.NONE;
    }

    /**
     * Calculates the scrollto-offset to which the spring is set.
     */
    function _calcScrollToOffset(size, scrollOffset) {
        if (!this._scroll.scrollToSequence) {
            return;
        }

        // 1. When boundary is reached, stop scrolling in that direction
        if ((this._scroll.boundsReached === Bounds.BOTH) ||
            (!this._scroll.scrollToDirection && (this._scroll.boundsReached === Bounds.PREV)) ||
            (this._scroll.scrollToDirection && (this._scroll.boundsReached === Bounds.NEXT))) {
            this._scroll.scrollToSequence = undefined;
            return;
        }

        // 2. Find the node to scroll to
        var foundNode;
        var scrollToOffset = 0;
        this._nodes.forEach(function(node) {
            if (node.scrollLength === undefined) {
                return true;
            }
            if (node._viewSequence === this._scroll.scrollToSequence) {
                foundNode = node;
                return true;
            }
            scrollToOffset -= node.scrollLength;
        }.bind(this), true);
        if (!foundNode) {
            scrollToOffset = 0;
            this._nodes.forEach(function(node) {
                if (node.scrollLength === undefined) {
                    return true;
                }
                scrollToOffset += node.scrollLength;
                if (node._viewSequence === this._scroll.scrollToSequence) {
                    foundNode = node;
                    return true;
                }
            }.bind(this), false);
        }
        if (foundNode) {
            this._scroll.springPosition = scrollToOffset;
            this._scroll.springSource = SpringSource.GOTOSEQUENCE;
            return;
        }

        // 3. When node not found, set the spring to a position into that direction
        if (this._scroll.scrollToDirection) {
            this._scroll.springPosition = scrollOffset - size[this._direction];
            this._scroll.springSource = SpringSource.GOTOPREVDIRECTION;
        }
        else {
            this._scroll.springPosition = scrollOffset + size[this._direction];
            this._scroll.springSource = SpringSource.GOTONEXTDIRECTION;
        }
    }

    /**
     * Snaps to a page when paginanation is enabled and the energy of the particle
     * is below the thesshold.
     */
    function _snapToPage(size, scrollOffset) {

        // Check whether pagination is active
        if (!this.options.paginated ||
            this._scroll.scrollForceCount ||
            (Math.abs(this._scroll.particle.getEnergy()) > this.options.paginationEnergyThresshold) ||
            (this._scroll.springPosition !== undefined)) {
            return;
        }

        // Local data
        var pageOffset = scrollOffset;
        var pageLength;
        var hasNext;

        // Lookup page in previous direction
        var bound = this.options.reverse ? size[this._direction] : 0;
        this._nodes.forEach(function(node) {
            if (node.scrollLength !== 0) {
                if ((pageOffset <= bound) || (node.scrollLength === undefined)) {
                    return true;
                }
                hasNext = (pageLength !== undefined);
                pageLength = node.scrollLength;
                pageOffset -= node.scrollLength;
            }
        }.bind(this), false);

        // Lookup page in next direction
        if (pageLength === undefined) {
            this._nodes.forEach(function(node) {
                if (node.scrollLength !== 0) {
                    if (node.scrollLength === undefined) {
                        return true;
                    }
                    hasNext = (pageLength !== undefined);
                    if (hasNext) {
                        if ((pageOffset + pageLength) > bound) {
                            return true;
                        }
                        pageOffset += pageLength;
                    }
                    pageLength = node.scrollLength;
                }
            }.bind(this), true);
        }
        if (!pageLength) {
            return;
        }

        // Determine snap spring-position
        var boundOffset = pageOffset - bound;
        var snapSpringPosition;
        if (!hasNext || (Math.abs(boundOffset) < Math.abs(boundOffset + pageLength))) {
            snapSpringPosition = (scrollOffset - pageOffset) + (this.options.reverse ? size[this._direction] : 0);
            if (snapSpringPosition !== this._scroll.springPosition) {
                //_log.call(this, 'setting snap-spring to #1: ', snapSpringPosition, ', previous: ', this._scroll.springPosition);
                this._scroll.springPosition = snapSpringPosition;
                this._scroll.springSource = SpringSource.SNAPPREV;
            }
        }
        else {
            snapSpringPosition = (scrollOffset - (pageOffset + pageLength)) + (this.options.reverse ? size[this._direction] : 0);
            if (snapSpringPosition !== this._scroll.springPosition) {
                //_log.call(this, 'setting snap-spring to #2: ', snapSpringPosition, ', previous: ', this._scroll.springPosition);
                this._scroll.springPosition = snapSpringPosition;
                this._scroll.springSource = SpringSource.SNAPNEXT;
            }
        }
    }

    /**
     * Normalizes the view-sequence node so that the view-sequence is near to 0.
     */
    function _normalizePrevViewSequence(size, scrollOffset, baseOffset) {
        var prevScrollLength;
        var normalizedCount = 0;
        var normalizedLength = 0;
        this._nodes.forEach(function(node) {
            if ((node.scrollLength === undefined) || node.trueSizeRequested) {
                return true;
            }
            if (this.options.reverse) {
                if (prevScrollLength !== undefined) {
                    if ((scrollOffset - prevScrollLength) <= baseOffset){
                        return true;
                    }
                    this._viewSequence = node._viewSequence;
                    scrollOffset -= prevScrollLength;
                    normalizedLength -= prevScrollLength;
                    normalizedCount++;
                }
                prevScrollLength = node.scrollLength;
            }
            else {
                if (scrollOffset <= baseOffset){
                    return true;
                }
                this._viewSequence = node._viewSequence;
                scrollOffset -= node.scrollLength;
                normalizedLength -= node.scrollLength;
                normalizedCount++;
            }
        }.bind(this), false);
        if (normalizedCount) {
            _log.call(this, 'normalized ', normalizedCount, ' prev node(s) with length: ', normalizedLength, ', scrollOffset: ', scrollOffset);
        }
        return scrollOffset;
    }
    function _normalizeNextViewSequence(size, scrollOffset, baseOffset) {
        var prevScrollLength;
        var normalizedCount = 0;
        var normalizedLength = 0;
        this._nodes.forEach(function(node) {
            if ((node.scrollLength === undefined) || node.trueSizeRequested) {
                return true;
            }
            if (this.options.reverse) {
                if (scrollOffset >= baseOffset){
                    return true;
                }
                this._viewSequence = node._viewSequence;
                scrollOffset += node.scrollLength;
                normalizedLength += node.scrollLength;
                normalizedCount++;
            }
            else {
                if (prevScrollLength !== undefined) {
                    if ((scrollOffset + prevScrollLength) >= baseOffset){
                        return true;
                    }
                    this._viewSequence = node._viewSequence;
                    scrollOffset += prevScrollLength;
                    normalizedLength += prevScrollLength;
                    normalizedCount++;
                }
                prevScrollLength = node.scrollLength;
            }
        }.bind(this), true);
        if (normalizedCount) {
            _log.call(this, 'normalized ', normalizedCount, ' next node(s) with length: ', normalizedLength, ', scrollOffset: ', scrollOffset);
        }
        return scrollOffset;
    }
    function _normalizeViewSequence(size, scrollOffset) {

        // Check whether normalisation is disabled
        if (this._layout.capabilities && this._layout.capabilities.debug &&
            (this._layout.capabilities.debug.normalize !== undefined) &&
            !this._layout.capabilities.debug.normalize) {
            return scrollOffset;
        }

        // Don't normalize when forces are at work
        if (this._scroll.scrollForceCount) {
            return scrollOffset;
        }

        // Determine base offset (by default 0 = top/left), but may be overwriten
        // by the layout function to test layout in the prev-direction.
        var baseOffset = 0; // top/left
        if (this._layout.capabilities && this._layout.capabilities.debug && this._layout.capabilities.debug.testPrev) {
            baseOffset = size[this._direction];
        }

        // 1. Normalize in primary direction
        var normalizedScrollOffset = scrollOffset;
        if (this.options.reverse) {
            normalizedScrollOffset = _normalizeNextViewSequence.call(this, size, scrollOffset, baseOffset);
        }
        else {
            normalizedScrollOffset = _normalizePrevViewSequence.call(this, size, scrollOffset, baseOffset);
        }

        // 2. Normalize in secondary direction
        if (normalizedScrollOffset === scrollOffset) {
            if (this.options.reverse) {
                normalizedScrollOffset = _normalizePrevViewSequence.call(this, size, scrollOffset, baseOffset);
            }
            else {
                normalizedScrollOffset = _normalizeNextViewSequence.call(this, size, scrollOffset, baseOffset);
            }
        }

        // Adjust particle and springs
        if (normalizedScrollOffset !== scrollOffset) {
            var delta = normalizedScrollOffset - scrollOffset;

            // Adjust particle
            _setParticle.call(this, this._scroll.particle.getPosition1D() + delta, undefined, 'normalize');

            // Adjust scroll spring
            if (this._scroll.springPosition !== undefined) {
                this._scroll.springPosition += delta;
            }

            // Adjust group offset
            if (this._layout.capabilities.sequentialScrollingOptimized) {
                this._scroll.groupStart -= delta;
            }
        }
        return normalizedScrollOffset;
    }

        /*function _getVisiblePercentage(spec) {
        var specLeft = spec.transform[12];
        var specTop = spec.transform[13];
        var specSize = spec.size;
        var left = Math.max(0, specLeft);
        var top = Math.max(0, specTop);
        var right = Math.min(this._contextSizeCache[0], specLeft + specSize[0]);
        var bottom = Math.min(this._contextSizeCache[1], specTop + specSize[1]);
        var width = right - left;
        var height = bottom - top;
        var volume = width * height;
        var totalVolume = spec.size[0] * spec.size[1];
        return totalVolume ? (volume / totalVolume) : 0;
    }

    function _getVisibleItem(spec) {
        return {
            spec: {
                opacity: spec.opacity,
                align: spec.align,
                origin: spec.origin,
                size: spec.size,
                transform: spec.transform
            },
            renderNode: spec.renderNode,
            visiblePerc: _getVisiblePercentage.call(this, spec)
        };
    }*/

    /**
     * Get the first visible item that meets the visible percentage criteria.
     * The percentage indicates how many pixels should at least visible before
     * the renderable is considered visible.
     * `visible percentage = (width * height) / (visible width * visible height)`
     *
     * @param {Number} [visiblePerc] percentage in the range of 0..1 (default: 0.99)
     * @return {Object} item object or undefined
     */
    ScrollView.prototype.getFirstVisibleItem = function(visiblePerc) {
        var scrollOffset = _calcScrollOffset.call(this);
        var next = scrollOffset <= 0;
        var foundNode;
        this._nodes.forEach(function(node) {
            if (node.scrollLength === undefined) {
                return true;
            }
            scrollOffset += next ? node.scrollLength : -node.scrollLength;
            if ((next && (scrollOffset > 0)) ||
                (!next && (scrollOffset <= 0))) {
                foundNode = node;
                return true;
            }
        }, next);
        return foundNode ? foundNode._viewSequence : undefined;
    };

    /**
     * Helper function that scrolls the view towards a view-sequence node.
     */
    function _scrollToSequence(viewSequence, next) {
        this._scroll.scrollToSequence = viewSequence;
        this._scroll.scrollToDirection = next;
        this._scroll.scrollDirty = true;
    }

    /**
     * Moves to the next node in the viewSequence.
     *
     * @param {Number} [amount] Amount of nodes to move
     */
    function _goToPage(amount) {

        // Get current scroll-position. When a previous call was made to
        // `scroll' or `scrollTo` and that node has not yet been reached, then
        // the amount is accumalated onto that scroll target.
        var viewSequence = this._scroll.scrollToSequence || this.getFirstVisibleItem() || this._viewSequence;
        if (!viewSequence) {
            return;
        }

        // When the first renderable is partially shown, then treat `-1` (previous)
        // as `show the current renderable fully`.
        if (!this._scroll.scrollToSequence && (amount < 0) && (_calcScrollOffset.call(this) < 0)){
            amount += 1;
        }

        // Find scroll target
        for (var i = 0; i < Math.abs(amount); i++) {
            var nextViewSequence = (amount > 0) ? viewSequence.getNext() : viewSequence.getPrevious();
            if (nextViewSequence) {
                viewSequence = nextViewSequence;
            }
            else {
                break;
            }
        }
        _scrollToSequence.call(this, viewSequence, amount >= 0);
    }

    /**
     * Halts all scrolling going on. In essence this function sets
     * the velocity to 0 and cancels any `goToXxx` operation that
     * was applied.
     *
     * @return {ScrollView} this
     */
    ScrollView.prototype.halt = function() {
        this._scroll.scrollToSequence = undefined;
        _setParticle.call(this, undefined, 0, 'halt');
        return this;
    };

    /**
     * Applies a permanent scroll-force (offset) until it is released.
     * When the cumulative scroll-offset lies outside the allowed bounds
     * a strech effect is used, and the offset beyond the bounds is
     * substracted by halve. This function should always be accompanied
     * by a call to `releaseScrollForce`.
     *
     * This method is used for instance when using touch gestures to move
     * the scroll offset and corresponds to the `touchstart` event.
     *
     * @param {Number} offset Scroll offset to add to the current
     * @return {ScrollView} this
     */
    ScrollView.prototype.applyScrollForce = function(offset) {
        this.halt();
        this._scroll.scrollForceCount++;
        this._scroll.scrollForce += offset;
        return this;
    };

    /**
     * Updates a existing scroll-force previously applied by calling
     * `applyScrollForce`.
     *
     * This method is used for instance when using touch gestures to move
     * the scroll offset and corresponds to the `touchmove` event.
     *
     * @param {Number} [prevOffset] Previous offset
     * @param {Number} [newOffset] New offset
     * @return {ScrollView} this
     */
    ScrollView.prototype.updateScrollForce = function(prevOffset, newOffset) {
        this.halt();
        newOffset -= prevOffset;
        this._scroll.scrollForce += newOffset;
        return this;
    };

    /**
     * Releases a scroll-force and sets the velocity.
     *
     * This method is used for instance when using touch gestures to move
     * the scroll offset and corresponds to the `touchend` event.
     *
     * @param {Number} offset Scroll offset to release
     * @param {Number} [velocity] Velocity to apply after which the view keeps scrolling
     * @return {ScrollView} this
     */
    ScrollView.prototype.releaseScrollForce = function(offset, velocity) {
        this.halt();
        if (this._scroll.scrollForceCount === 1) {
            var scrollOffset = _calcScrollOffset.call(this);
            _setParticle.call(this, scrollOffset, velocity, 'releaseScrollForce');
            this._scroll.pe.wake();
            this._scroll.scrollForce = 0;
            this._scroll.scrollDirty = true;
        }
        else {
            this._scroll.scrollForce -= offset;
        }
        this._scroll.scrollForceCount--;
        return this;
    };

    /**
     * Checks whether the scrollview can scroll the given offset.
     * When the scrollView can scroll the whole offset, then
     * the return value is the same as the offset. If it cannot
     * scroll the entire offset, the return value is the number of
     * pixels that can be scrolled.
     *
     * @return {Number} number of pixels the view can scroll or offset
     */
    ScrollView.prototype.canScroll = function(offset) {

        // Calculate height in both directions
        var scrollOffset = _calcScrollOffset.call(this);
        var prevHeight = _calcHeight.call(this, false);
        var nextHeight = _calcHeight.call(this, true);

        // When the rendered height is smaller than the total height,
        // then no scrolling whatsover is allowed.
        var totalHeight;
        if ((nextHeight !== undefined) && (prevHeight !== undefined)) {
            totalHeight = prevHeight + nextHeight;
        }
        if ((totalHeight !== undefined) && (totalHeight <= this._contextSizeCache[this._direction])) {
            return 0; // no scrolling at all allowed
        }

        // Determine the offset that we can scroll
        if ((offset < 0) && (nextHeight !== undefined)) {
            var nextOffset = this._contextSizeCache[this._direction] - (scrollOffset + nextHeight);
            return Math.min(nextOffset, offset);
        } else if ((offset > 0) && (prevHeight !== undefined)) {
            var prevOffset = -(scrollOffset - prevHeight);
            return Math.min(prevOffset, offset);
        }
        return offset;
    };

    /**
     * Scrolls the view by the specified offset.
     *
     * @return {ScrollView} this
     */
    ScrollView.prototype.scroll = function(offset) {
        this.halt();
        this._scroll.scrollDelta += offset;
        return this;
    };

    /**
     * Checks whether any boundaries have been reached.
     *
     * @return {ScrollView.Bounds} Either, Bounds.PREV, Bounds.NEXT, Bounds.BOTH or Bounds.NONE
     */
    ScrollView.prototype.getBoundsReached = function() {
        return this._scroll.boundsReached;
    };

    /**
     * Scroll to the previous page, making it visible.
     *
     * @return {ScrollView} this
     */
    ScrollView.prototype.goToPreviousPage = function() {
        _goToPage.call(this, -1);
        return this;
    };

    /**
     * Scroll to the next page, making it visible.
     *
     * @return {ScrollView} this
     */
    ScrollView.prototype.goToNextPage = function() {
        _goToPage.call(this, 1);
        return this;
    };

    /**
     * Scroll to the given renderable in the datasource.
     *
     * @param {RenderNode} node renderable to scroll to
     * @return {ScrollView} this
     */
    ScrollView.prototype.goToRenderNode = function(node) {

        // Verify arguments and state
        if (!this._viewSequence || !node) {
            return this;
        }

        // Check current node
        if (this._viewSequence.get() === node) {
            var next = _calcScrollOffset.call(this) >= 0;
            _scrollToSequence.call(this, this._viewSequence, next);
            return this;
        }

        // Find the sequence-node that we want to scroll to.
        // We look at both directions at the same time.
        // The first match that is encountered, that direction is chosen.
        var nextSequence = this._viewSequence.getNext();
        var prevSequence = this._viewSequence.getPrevious();
        while ((nextSequence || prevSequence) && (nextSequence !== this._viewSequence)){
            var nextNode = nextSequence ? nextSequence.get() : undefined;
            if (nextNode === node) {
                _scrollToSequence.call(this, nextSequence, true);
                break;
            }
            var prevNode = prevSequence ? prevSequence.get() : undefined;
            if (prevNode === node) {
                _scrollToSequence.call(this, prevSequence, false);
                break;
            }
            nextSequence = nextNode ? nextSequence.getNext() : undefined;
            prevSequence = prevNode ? prevSequence.getPrevious() : undefined;
        }
        return this;
    };

    /**
     * Executes the layout and updates the state of the scrollview.
     */
    function _layout(size, scrollOffset, nested) {
        _verifyIntegrity.call(this, 'layout', scrollOffset);

        // Track the number of times the layout-function was executed
        this._debug.layoutCount++;
        //_log.call(this, 'Layout, scrollOffset: ', scrollOffset, ', particle: ', this._scroll.particle.getPosition1D());

        // Prepare for layout
        var layoutContext = this._nodes.prepareForLayout(
            this._viewSequence,     // first node to layout
            this._nodesById, {      // so we can do fast id lookups
                size: size,
                direction: this._direction,
                reverse: this.options.reverse,
                scrollOffset: this.options.reverse ? (scrollOffset + size[this._direction]) : scrollOffset,
                scrollStart: scrollOffset - size[this._direction],
                scrollEnd: scrollOffset + (size[this._direction] * 2)
            }
        );
        _verifyIntegrity.call(this, 'prepareLayout');

        // Layout objects
        if (this._layout.function) {
            this._layout.function(
                layoutContext,          // context which the layout-function can use
                this._layout.options    // additional layout-options
            );
        }
        _verifyIntegrity.call(this, 'layout.function', scrollOffset);

        // Mark non-invalidated nodes for removal
        this._nodes.removeNonInvalidatedNodes(this.options.removeSpec);
        _verifyIntegrity.call(this, 'removeNonInvalidatedNodes', scrollOffset);

        // Check whether the bounds have been reached
        _calcBounds.call(this, size, scrollOffset);
        _verifyIntegrity.call(this, 'calcBounds', scrollOffset);

        // Update scroll-to spring
        _calcScrollToOffset.call(this, size, scrollOffset);
        _verifyIntegrity.call(this, 'calcScrollToOffset', scrollOffset);

        // When pagination is enabled, snap to page
        _snapToPage.call(this, size, scrollOffset);
        _verifyIntegrity.call(this, 'snapToPage', scrollOffset);

        // If the bounds have changed, and the scroll-offset would be different
        // than before, then re-layout entirely using the new offset.
        var newScrollOffset = _calcScrollOffset.call(this, true);
        if (!nested && (newScrollOffset !== scrollOffset)) {
            _log.call(this, 'offset changed, re-layouting... (', scrollOffset, ' != ', newScrollOffset, ')');
            return _layout.call(this, size, newScrollOffset, true);
        }

        // Calculate the spec-output
        var result = this._nodes.buildSpecAndDestroyUnrenderedNodes();
        _verifyIntegrity.call(this, 'buildSpecAndDestroyUnrenderedNodes', scrollOffset);
        this._specs = result.specs;
        if (result.modified || true) {
            this._eventOutput.emit('reflow', {
                target: this
            });
        }

        // Normalize scroll offset so that the current viewsequence node is as close to the
        // top as possible and the layout function will need to process the least amount
        // of renderables.
        scrollOffset = _normalizeViewSequence.call(this, size, scrollOffset);
        _verifyIntegrity.call(this, 'normalizeViewSequence', scrollOffset);

        // Update spring
        _updateSpring.call(this);
        _verifyIntegrity.call(this, 'setSpring', scrollOffset);

        return scrollOffset;
    }

    /**
     * Override of the setDirection function to detect whether the
     * direction has changed. If so, the directionLock on the nodes
     * is updated.
     */
    var oldSetDirection = ScrollView.prototype.setDirection;
    ScrollView.prototype.setDirection = function(direction) {
        var oldDirection = this._direction;
        oldSetDirection.call(this, direction);
        if (oldDirection !== this._direction) {
            this._nodes.forEach(function(node) {
                if (node.setDirectionLock) {
                    node.setDirectionLock(this._direction, 0);
                }
            }.bind(this));
        }
    };

    /**
     * Inner render function of the Group
     */
    function _innerRender() {
        var specs;
        var i;

        // When sequential scrolling is optimized, translate the spec back
        // to a sequential position so that the matrix is unchanged and
        // famo.s doesn't have to update the matrix in the DOM.
        if (this._layout.capabilities.sequentialScrollingOptimized) {
            specs = [];
            var scrollOffset = this._scrollOffsetCache;
            var translate = [0, 0, 0];
            translate[this._direction] = -this._scroll.groupStart - scrollOffset;
            for (i = 0; i < this._specs.length; i++) {
                var spec = this._specs[i];
                var transform = Transform.thenMove(spec.transform, translate);
                /*var newSpec = spec._windowSpec;
                if (!newSpec) {
                    newSpec = {};
                    spec._windowSpec = newSpec;
                }*/
                var newSpec = {};
                newSpec.origin = spec.origin;
                newSpec.align = spec.align;
                newSpec.opacity = spec.opacity;
                newSpec.size = spec.size;
                newSpec.transform = transform;
                newSpec.target = spec.renderNode.render();
                newSpec.scrollOffset = scrollOffset;
                /*if (spec._translatedSpec) {
                    if (!LayoutUtility.isEqualSpec(newSpec, spec._translatedSpec)) {
                        var diff = LayoutUtility.getSpecDiffText(newSpec, spec._translatedSpec);
                        _log.call(this, diff + ' (scrollOffset: ' + spec._translatedSpec.scrollOffset + ' != ' + scrollOffset + ', groupStart: ' + this._scroll.groupStart + ')');
                    }
                }
                else {
                    _log.call(this, 'new spec rendered');
                }*/
                spec._translatedSpec = newSpec;
                specs.push(newSpec);
            }
        }
        else {

            // Call render on all nodes
            specs = this._specs;
            for (i = 0; i < specs.length; i++) {
                specs[i].target = specs[i].renderNode.render();
            }
        }
        return specs;
    }

    /**
     * Apply changes from this component to the corresponding document element.
     * This includes changes to classes, styles, size, content, opacity, origin,
     * and matrix transforms.
     *
     * @private
     * @method commit
     * @param {Context} context commit context
     */
    ScrollView.prototype.commit = function commit(context) {
        var size = context.size;
        var scrollOffset = _calcScrollOffset.call(this, true);

        // When the size or layout function has changed, reflow the layout
        if (size[0] !== this._contextSizeCache[0] ||
            size[1] !== this._contextSizeCache[1] ||
            this._isDirty ||
            this._scroll.scrollDirty ||
            this._nodes._trueSizeRequested ||
            this._scrollOffsetCache !== scrollOffset) {

            // Emit start event
            var eventData = {
                target: this,
                oldSize: this._contextSizeCache,
                size: size,
                oldScrollOffset: this._scrollOffsetCache,
                scrollOffset: scrollOffset,
                dirty: this._isDirty,
                trueSizeRequested: this._nodes._trueSizeRequested
            };
            this._eventOutput.emit('layoutstart', eventData);

            // When the layout has changed, and we are not just scrolling,
            // disable the locked state of the layout-nodes so that they
            // can freely transition between the old and new state.
            if (this._isDirty) {
                this._nodes.forEach(function(node) {
                    if (node.setDirectionLock) {
                        node.setDirectionLock(this._direction, 0);
                    }
                }.bind(this));
            }

            // Update state
            this._contextSizeCache[0] = size[0];
            this._contextSizeCache[1] = size[1];
            this._scrollOffsetCache = scrollOffset;
            this._isDirty = false;
            this._scroll.scrollDirty = false;

            // Perform layout
            scrollOffset = _layout.call(this, size, scrollOffset);
            this._scrollOffsetCache = scrollOffset;

            // Emit end event
            this._eventOutput.emit('layoutend', eventData);
        }
        else {

            // Update output and optionally emit event
            var result = this._nodes.buildSpecAndDestroyUnrenderedNodes();
            this._specs = result.specs;
            if (result.modified) {
                this._eventOutput.emit('reflow', {
                    target: this
                });
            }
        }

        // When renderables are layed out sequentiall (e.g. a ListLayout or
        // CollectionLayout), then offset the renderables onto the Group
        // and move the group offset instead. This creates a very big performance gain
        // as the renderables don't have to be repositioned for every change
        // to the scrollOffset. For layouts that don't layout sequence, disable
        // this behavior as it will be decremental to the performance.
        var transform = context.transform;
        if (this._layout.capabilities.sequentialScrollingOptimized) {
            var windowOffset = scrollOffset + this._scroll.groupStart;
            transform = this._direction ? Transform.translate(0, windowOffset, 0) : Transform.translate(windowOffset, 0, 0);
            transform = Transform.multiply(context.transform, transform);
        }

        // Return the spec
        return {
            transform: transform,
            size: size,
            opacity: context.opacity,
            origin: context.origin,
            target: this.group.render()
        };
    };

    /**
     * Generate a render spec from the contents of this component.
     *
     * @private
     * @method render
     * @return {number} Render spec for this component
     */
    ScrollView.prototype.render = function render() {
        if (this.container) {
            return this.container.render.apply(this.container, arguments);
        }
        else {
            return this.id;
        }
    };

    module.exports = ScrollView;
});
