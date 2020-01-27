import { Plugin, HandleRequest, EnumRequestType } from 'jovo-core';
import _set = require('lodash.set');
import _get = require('lodash.get');
import _unionWith = require('lodash.unionwith');

import { GoogleAssistant } from '../GoogleAssistant';
import { GoogleAction } from '../core/GoogleAction';
import { GoogleActionResponse } from '../core/GoogleActionResponse';
import { GoogleActionSpeechBuilder } from '../core/GoogleActionSpeechBuilder';

import uuidv4 = require('uuid/v4');
import { EnumGoogleAssistantRequestType } from '../core/google-assistant-enums';
import { Item, RichResponse, SimpleResponse } from '../core/Interfaces';
import { SessionEntity, SessionEntityType } from 'jovo-platform-dialogflow';

export class GoogleAssistantCore implements Plugin {
  install(googleAssistant: GoogleAssistant) {
    googleAssistant.middleware('$init')!.use(this.init.bind(this));
    googleAssistant.middleware('$type')!.use(this.type.bind(this));

    googleAssistant.middleware('after.$type')!.use(this.userStorageGet.bind(this));

    googleAssistant.middleware('$output')!.use(this.output.bind(this));
    googleAssistant.middleware('after.$output')!.use(this.userStorageStore.bind(this));

    GoogleAction.prototype.displayText = function(displayText: string) {
      _set(this.$output, 'GoogleAssistant.displayText', displayText);
      return this;
    };

    GoogleAction.prototype.richResponse = function(richResponse: RichResponse) {
      _set(this.$output, 'GoogleAssistant.RichResponse', richResponse);
      return this;
    };

    GoogleAction.prototype.appendResponse = function(responseItem: Item) {
      if (this.$output.GoogleAssistant && this.$output.GoogleAssistant.ResponseAppender) {
        this.$output.GoogleAssistant.ResponseAppender.push(responseItem);
      } else {
        if (!this.$output.GoogleAssistant) {
          this.$output.GoogleAssistant = {};
        }

        this.$output.GoogleAssistant.ResponseAppender = [responseItem];
      }
      return this;
    };

    GoogleAction.prototype.appendSimpleResponse = function(simpleResponse: SimpleResponse) {
      this.appendResponse({
        simpleResponse,
      });
      return this;
    };

    GoogleAction.prototype.addSessionEntityTypes = function(
      sessionEntityTypes: SessionEntityType[],
    ) {
      if (!this.$output.GoogleAssistant) {
        this.$output.GoogleAssistant = {};
      }

      if (!this.$output.GoogleAssistant.SessionEntityTypes) {
        this.$output.GoogleAssistant.SessionEntityTypes = [];
      }

      sessionEntityTypes.forEach((el: SessionEntityType) => {
        // Place session id in front of session entity name to accomodate to proper format
        const sessionId = this.$request!.getSessionId();
        const entityName = el.name;
        el.name = `${sessionId}/entityTypes/${entityName}`;

        // Set default override mode
        if (!el.entityOverrideMode) {
          el.entityOverrideMode = 'ENTITY_OVERRIDE_MODE_SUPPLEMENT';
        }
      });

      this.$output.GoogleAssistant.SessionEntityTypes = _unionWith(
        this.$output.GoogleAssistant.SessionEntityTypes,
        sessionEntityTypes,
        (first: SessionEntityType, second: SessionEntityType) => {
          if (first.name !== second.name) {
            return false;
          }

          const entities = _unionWith(
            first.entities,
            second.entities,
            (f: SessionEntity, s: SessionEntity) => {
              if (f.value !== s.value) {
                return false;
              }

              s.synonyms = s.synonyms.concat(f.synonyms);
              return true;
            },
          );

          second.entities = entities;
          return true;
        },
      );

      return this;
    };

    GoogleAction.prototype.addSessionEntityType = function(sessionEntityType: SessionEntityType) {
      return this.addSessionEntityTypes([sessionEntityType]);
    };

    GoogleAction.prototype.addSessionEntity = function(
      name: string,
      value: string,
      synonyms: string[],
      entityOverrideMode = 'ENTITY_OVERRIDE_MODE_SUPPLEMENT',
    ) {
      const sessionEntityType: SessionEntityType = {
        name,
        entityOverrideMode,
        entities: [{ value, synonyms }],
      };
      return this.addSessionEntityType(sessionEntityType);
    };
  }

  async init(handleRequest: HandleRequest) {
    const requestObject = handleRequest.host.$request;
    /**
     * placeholder, since GoogleAction can't be run without dialogflow currently.
     * Platform object creation is therefore handled by dialogflow integration.
     */
    if (
      requestObject.user &&
      requestObject.conversation &&
      requestObject.surface &&
      requestObject.availableSurfaces
    ) {
      handleRequest.jovo = new GoogleAction(handleRequest.app, handleRequest.host, handleRequest);
    }
  }

  type(googleAction: GoogleAction) {
    if (
      _get(googleAction.$originalRequest || googleAction.$request, 'inputs[0].intent') ===
      'actions.intent.CANCEL'
    ) {
      _set(googleAction.$type, 'type', EnumRequestType.END);
    }
    if (
      _get(
        googleAction.$originalRequest || googleAction.$request,
        'inputs[0].arguments[0].name',
      ) === 'is_health_check' &&
      _get(
        googleAction.$originalRequest || googleAction.$request,
        'inputs[0].arguments[0].boolValue',
      ) === true &&
      googleAction.$app.config.handlers.ON_HEALTH_CHECK
    ) {
      _set(googleAction.$type, 'type', EnumGoogleAssistantRequestType.ON_HEALTH_CHECK);
      _set(googleAction.$type, 'optional', true);
    }
  }

  async output(googleAction: GoogleAction) {
    const output = googleAction.$output;
    if (!googleAction.$originalResponse) {
      googleAction.$originalResponse = new GoogleActionResponse();
    }

    const tell = _get(output, 'GoogleAssistant.tell') || _get(output, 'tell');
    if (tell) {
      _set(googleAction.$originalResponse, 'expectUserResponse', false);
      _set(googleAction.$originalResponse, 'richResponse.items', [
        {
          simpleResponse: {
            ssml: GoogleActionSpeechBuilder.toSSML(tell.speech),
          },
        },
      ]);
    }
    const ask = _get(output, 'GoogleAssistant.ask') || _get(output, 'ask');

    if (ask) {
      _set(googleAction.$originalResponse, 'expectUserResponse', true);

      // speech
      _set(googleAction.$originalResponse, 'richResponse.items', [
        {
          simpleResponse: {
            ssml: GoogleActionSpeechBuilder.toSSML(ask.speech),
          },
        },
      ]);

      // reprompts
      const noInputPrompts: any[] = []; // tslint:disable-line

      if (output.ask && output.ask.reprompt && typeof output.ask.reprompt === 'string') {
        noInputPrompts.push({
          ssml: GoogleActionSpeechBuilder.toSSML(ask.reprompt),
        });
      } else if (Array.isArray(ask.reprompt)) {
        ask.reprompt.forEach((reprompt: string) => {
          noInputPrompts.push({
            ssml: GoogleActionSpeechBuilder.toSSML(reprompt),
          });
        });
      }
      _set(googleAction.$originalResponse, 'noInputPrompts', noInputPrompts);
    }

    if (_get(output, 'GoogleAssistant.displayText') && googleAction.hasScreenInterface()) {
      _set(
        googleAction.$originalResponse,
        'richResponse.items[0].simpleResponse.displayText',
        _get(output, 'GoogleAssistant.displayText'),
      );
    }

    if (output.GoogleAssistant && output.GoogleAssistant.RichResponse) {
      _set(googleAction.$originalResponse, 'richResponse', output.GoogleAssistant.RichResponse);
    }

    if (output.GoogleAssistant && output.GoogleAssistant.ResponseAppender) {
      let responseItems = _get(googleAction.$originalResponse, 'richResponse.items', []);
      responseItems = responseItems.concat(output.GoogleAssistant.ResponseAppender);
      _set(googleAction.$originalResponse, 'richResponse.items', responseItems);
    }

    if (output.GoogleAssistant && output.GoogleAssistant.SessionEntityTypes) {
      const responseItems = output.GoogleAssistant.SessionEntityTypes;
      _set(googleAction.$originalResponse, 'sessionEntityTypes', responseItems);
    }
  }
  async userStorageGet(googleAction: GoogleAction) {
    try {
      googleAction.$user.$storage = JSON.parse(
        _get(googleAction.$originalRequest || googleAction.$request, 'user.userStorage'),
      );
    } catch (e) {}

    const userId =
      googleAction.$user.$storage.userId || googleAction.$request!.getUserId() || uuidv4();

    googleAction.$user.$storage.userId = userId;
  }
  async userStorageStore(googleAction: GoogleAction) {
    const output = googleAction.$output;
    if (!googleAction.$originalResponse) {
      googleAction.$originalResponse = new GoogleActionResponse();
    }
    _set(
      googleAction.$originalResponse,
      'userStorage',
      JSON.stringify(googleAction.$user.$storage),
    );
  }
  uninstall(googleAssistant: GoogleAssistant) {}
}
