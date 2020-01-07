// TODO-MVP: Add custom scalars such as graphql-iso-date
// import { GraphQLDate, GraphQLDateTime, GraphQLTime } from 'graphql-iso-date';

import { ApolloServer, Config as ApolloServerConfig, Request } from 'apollo-server-lambda';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { GraphQLID, GraphQLSchema } from 'graphql';
import { AuthChecker, buildSchema } from 'type-graphql';
import { Container } from 'typedi';
import { Connection, ConnectionOptions, useContainer as TypeORMUseContainer } from 'typeorm';

import { createDBConnection, Config, BaseContext } from '@warthog/core';

interface Context extends BaseContext {
  user: {
    email: string;
    id: string;
    permissions: string;
  };
}

export interface ServerOptions<T> {
  container?: Container;
  apolloConfig?: ApolloServerConfig;
  authChecker?: AuthChecker<T>;
  autoGenerateFiles?: boolean;
  context?: (request: Request) => object;
  host?: string;
  generatedFolder?: string;
  middlewares?: any[];
  mockDBConnection?: boolean;
  openPlayground?: boolean;
  port?: string | number;
  resolversPath?: string[];
}

export class Server<C extends BaseContext> {
  config: Config;
  apolloConfig?: ApolloServerConfig;
  authChecker?: AuthChecker<C>;
  connection!: Connection;
  container: Container;
  graphQLServer!: ApolloServer;
  handler!: APIGatewayProxyHandler;
  schema?: GraphQLSchema;

  constructor(
    private appOptions: ServerOptions<C>,
    private dbOptions: Partial<ConnectionOptions> = {}
  ) {
    if (typeof this.appOptions.generatedFolder !== 'undefined') {
      process.env.WAY_GENERATED_FOLDER = this.appOptions.generatedFolder;
    }
    if (typeof this.appOptions.mockDBConnection !== 'undefined') {
      process.env.WAY_MOCK_DATABASE = this.appOptions.mockDBConnection ? 'true' : 'false';
    }

    this.container = this.appOptions.container || Container;
    TypeORMUseContainer(this.container as any); // TODO: fix any

    this.authChecker = this.appOptions.authChecker;
    this.apolloConfig = this.appOptions.apolloConfig || {};
    this.config = new Config({ container: this.container });

    if (!process.env.NODE_ENV) {
      throw new Error("NODE_ENV must be set - use 'development' locally");
    }
  }

  async establishDBConnection(): Promise<Connection> {
    if (!this.connection) {
      this.connection = await createDBConnection(this.dbOptions);
    }

    return this.connection;
  }

  async buildGraphQLSchema(): Promise<GraphQLSchema> {
    (global as any).schema =
      (global as any).schema ||
      (await buildSchema({
        authChecker: this.authChecker,
        scalarsMap: [
          {
            type: 'ID' as any,
            scalar: GraphQLID
          }
        ],
        container: this.container as any,
        // TODO: ErrorLoggerMiddleware
        globalMiddlewares: [/*DataLoaderMiddleware,*/ ...(this.appOptions.middlewares || [])],
        resolvers: this.config.get('RESOLVERS_PATH')
        // TODO: scalarsMap: [{ type: GraphQLDate, scalar: GraphQLDate }]
      }));

    this.schema = (global as any).schema as GraphQLSchema;

    return this.schema;
  }

  async start() {
    await this.establishDBConnection();
    await this.buildGraphQLSchema();

    const contextGetter =
      this.appOptions.context ||
      (async () => {
        return {};
      });

    this.graphQLServer = new ApolloServer({
      context: async (options: { req: Request }) => {
        const consumerCtx = await contextGetter(options.req);

        return {
          connection: this.connection,
          dataLoader: {
            initialized: false,
            loaders: {}
          },
          request: options.req,
          // Allows consumer to add to the context object - ex. context.user
          ...consumerCtx
        };
      },
      playground: true,
      introspection: true,
      schema: this.schema,
      ...this.apolloConfig
    });

    this.handler = this.graphQLServer.createHandler({});

    return this;
  }

  async stop() {
    await this.connection.close();
  }
}

// Backwards compatability.  This was renamed.
export const App = Server;
