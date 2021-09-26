'use strict';
import { getTypeScriptReader, getOpenApiWriter, makeConverter } from 'typeconv';
import swaggerFunctions from './resources/functions';
import * as fs from 'fs';

import {
    Serverless,
    ServerlessOptions,
    ServerlessCommand,
    ServerlessHooks,
    HttpEvent,
    HttpApiEvent,
    HttpResponses,
    FullHttpEvent,
    FullHttpApiEvent,
} from './serverlessPlugin';
import { Swagger, Definition, Paths, Response } from './swagger';
import { removeStringFromArray, writeFile } from './helperFunctions';

class ServerlessAutoSwagger {
    serverless: Serverless;
    options: ServerlessOptions;
    swagger: Swagger = {
        swagger: '2.0',
        info: {
            title: '',
            version: '1',
        },
        schemes: ['https'],
        paths: {},
    };

    commands: { [key: string]: ServerlessCommand } = {};
    hooks: ServerlessHooks = {};

    constructor(serverless: Serverless, options: ServerlessOptions) {
        this.serverless = serverless;
        this.options = options;

        this.commands = {
            'generate-swagger': {
                usage: 'Generates Swagger for your API',
                lifecycleEvents: ['gatherTypes', 'generateSwagger', 'addEndpointsAndLambda'],
            },
        };

        this.hooks = {
            'before:generate-swagger:gatherTypes': this.beforeGather,
            'generate-swagger:gatherTypes': this.gatherTypes,
            'generate-swagger:generateSwagger': this.generateSwagger,
            'generate-swagger:addEndpointsAndLambda': this.addEndpointsAndLambda,
            'before:offline:start:init': this.addEndpointsAndLambda,

            // TODO hook into the deployment as well to generate and add endpoints
        };
    }

    beforeGather = () => {
        this.serverless.cli.log(`Creating your Swagger File now`);
        // get the details from the package.json? for info
        this.swagger.info.title = this.serverless.service.service;
    };

    gatherTypes = async () => {
        this.serverless.cli.log('this is where we gather the types into a single file');

        const reader = getTypeScriptReader();
        const writer = getOpenApiWriter({
            format: 'json',
            title: this.serverless.service.service,
            version: 'v1',
            schemaVersion: '2.0',
        });
        const { convert } = makeConverter(reader, writer);
        try {
            const typeLocationOverride = this.serverless.service.custom?.swagger
                ?.typefiles as string[];
            const typesFile = typeLocationOverride || ['./src/types/api-types.d.ts'];
            let combinedDefinitions = {};
            await Promise.all(
                typesFile.map(async filepath => {
                    const fileData = fs.readFileSync(filepath, 'utf8');

                    const { data } = await convert({ data: fileData });
                    // change the #/components/schema to #/definitions
                    const definitionsData = data.replace(/\/components\/schema/g, '/definitions');

                    const definition: { [key: string]: Definition } =
                        JSON.parse(definitionsData).components.schemas;

                    if (data.includes('anyOf')) {
                        console.log('includes anyOf', definition);
                        //const newDef = Object.values(definition).map(recursiveFixAnyOf);
                    }

                    combinedDefinitions = { ...combinedDefinitions, ...definition };
                })
            );

            this.swagger.definitions = combinedDefinitions;
            // TODO change this to store these as temporary and only include definitions used elsewhere.
        } catch (error) {
            console.log('error getting types', error);
        }
    };

    generateSwagger = async () => {
        this.generatePaths();

        const swaggerString = `// this file was generated by serverless-auto-swagger
module.exports = ${JSON.stringify(this.swagger, null, 2)};`;

        await writeFile('./swagger.js', swaggerString);
    };

    addEndpointsAndLambda = async () => {
        this.serverless.service.functions = {
            ...this.serverless.service.functions,
            ...swaggerFunctions,
        };
    };

    generatePaths = () => {
        const functions = this.serverless.service.functions;
        const paths: Paths = {};
        Object.entries(functions).map(([functionName, config]) => {
            const events = config.events || [];
            events
                .filter(event => (event as HttpEvent).http || (event as HttpApiEvent).httpApi)
                .map(event => {
                    let http = (event as HttpEvent).http || (event as HttpApiEvent).httpApi;
                    if (typeof http === 'string') {
                        // TODO they're using the shorthand - parse that into object.
                        return;
                    }

                    let path = http.path;
                    if (path[0] !== '/') path = `/${path}`;

                    if (!paths[path]) {
                        paths[path] = {};
                    }

                    paths[path][http.method] = {
                        summary: functionName,
                        description: http.description || '',
                        tags: http.swaggerTags,
                        operationId: functionName,
                        consumes: ['application/json'],
                        produces: ['application/json'],
                        parameters: this.httpEventToParameters(http),
                        responses: this.formatResponses(http.responses),
                        security: this.httpEventToSecurity(http),
                    };
                });
        });

        this.swagger.paths = paths;
    };

    formatResponses = (responses: HttpResponses | undefined) => {
        if (!responses) {
            // could throw error
            return {
                200: {
                    description: '200 response',
                },
            };
        }
        const formatted: { [key: string]: Response } = {};
        Object.entries(responses).map(([statusCode, responseDetails]) => {
            if (typeof responseDetails == 'string') {
                formatted[statusCode] = {
                    description: responseDetails,
                };
                return;
            }
            let response: Response = {
                description: responseDetails.description || `${statusCode} response`,
            };
            if (responseDetails.bodyType) {
                response.schema = { $ref: `#/definitions/${responseDetails.bodyType}` };
            }

            formatted[statusCode] = response;
        });

        return formatted;
    };
    httpEventToSecurity = (http: EitherHttpEvent) => {
        // TODO - add security sections
        http.path;
        return undefined;
    };

    httpEventToParameters = (httpEvent: EitherHttpEvent) => {
        const parameters = [];
        if (httpEvent.bodyType) {
            parameters.push({
                in: 'body',
                name: 'body',
                description: 'Body required in the request',
                required: true,
                schema: {
                    $ref: `#/definitions/${httpEvent.bodyType}`,
                },
            });
        }
        if (
            !(httpEvent as FullHttpEvent['http']).parameters?.path &&
            httpEvent.path.match(/[^{\}]+(?=})/g)
        ) {
            const pathParameters = httpEvent.path.match(/[^{\}]+(?=})/g) || [];
            pathParameters.map(param => {
                parameters.push({
                    name: param,
                    in: 'path',
                    required: true,
                    type: 'string',
                });
            });
        }
        if ((httpEvent as FullHttpEvent['http']).parameters?.path) {
            const rawPathParams = (httpEvent as FullHttpEvent['http']).parameters?.path || {};
            let pathParameters = httpEvent.path.match(/[^{\}]+(?=})/g) || [];
            Object.entries(rawPathParams).map(([param, required]) => {
                parameters.push({
                    name: param,
                    in: 'path',
                    required,
                    type: 'string',
                });
                pathParameters = removeStringFromArray(pathParameters, param);
            });

            pathParameters.map(param => {
                parameters.push({
                    name: param,
                    in: 'path',
                    required: true,
                    type: 'string',
                });
            });
        }

        return parameters;
    };
}

module.exports = ServerlessAutoSwagger;

type EitherHttpEvent = FullHttpEvent['http'] | FullHttpApiEvent['httpApi'];
