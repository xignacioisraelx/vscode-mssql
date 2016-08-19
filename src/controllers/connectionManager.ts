'use strict';
import vscode = require('vscode');
import Constants = require('../models/constants');
import Utils = require('../models/utils');
import Interfaces = require('../models/interfaces');
import { ConnectionUI } from '../views/connectionUI';
import StatusView from '../views/statusView';
import SqlToolsServerClient from '../languageservice/serviceclient';
import { LanguageClient, RequestType } from 'vscode-languageclient';
import { IPrompter } from '../prompts/question';
import Telemetry from '../models/telemetry';

const mssql = require('mssql');

// Connection request message callback declaration
export namespace ConnectionRequest {
     export const type: RequestType<ConnectParams, ConnectionResult, void> = { get method(): string { return 'connection/connect'; } };
}

// Required parameters to initialize a connection to a database
class ConnectionDetails {
    // server name
    public serverName: string;

    // database name
    public databaseName: string;

    // user name
    public userName: string;

    // unencrypted password
    public password: string;
}

// Connention request message format
class ConnectParams {
    // URI identifying the owner of the connection
    public ownerUri: string;

    // Details for creating the connection
    public connection: ConnectionDetails;
}

// Connection response format
class ConnectionResult {
    // connection id returned from service host
    public connectionId: number;

    // any diagnostic messages return from the service host
    public messages: string;
}

// ConnectionManager class is the main controller for connection management
export default class ConnectionManager {
    private _context: vscode.ExtensionContext;
    private _statusView: StatusView;
    private _prompter: IPrompter;
    private _connection;
    private _connectionCreds: Interfaces.IConnectionCredentials;
    private _connectionUI: ConnectionUI;

    constructor(context: vscode.ExtensionContext, statusView: StatusView, prompter: IPrompter) {
        this._context = context;
        this._statusView = statusView;
        this._prompter = prompter;
        this._connectionUI = new ConnectionUI(context, prompter);
    }

    get connectionCredentials(): Interfaces.IConnectionCredentials {
        return this._connectionCreds;
    }

    get connection(): any {
        return this._connection;
    }

    private get connectionUI(): ConnectionUI {
        return this._connectionUI;
    }

    private get statusView(): StatusView {
        return this._statusView;
    }

    get isConnected(): boolean {
        return this._connection && this._connection.connected;
    }

    // choose database to use on current server
    public onChooseDatabase(): void {
        const self = this;

        if (typeof self._connection === 'undefined' || typeof self._connectionCreds === 'undefined') {
            Utils.showWarnMsg(Constants.msgChooseDatabaseNotConnected);
            return;
        }

        self.connectionUI.showDatabasesOnCurrentServer(self._connectionCreds).then( newDatabaseCredentials => {
            if (typeof newDatabaseCredentials !== 'undefined') {
                self.onDisconnect().then( () => {
                    self.connect(newDatabaseCredentials);
                });
            }
        });
    }

    // close active connection, if any
    public onDisconnect(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            if (this.isConnected) {
                this._connection.close();
            }

            this._connection = undefined;
            this._connectionCreds = undefined;
            this.statusView.notConnected();
            resolve(true);
        });
    }

    // let users pick from a picklist of connections
    public onNewConnection(): Promise<boolean> {
        const self = this;
        return new Promise<boolean>((resolve, reject) => {
            // show connection picklist
            self.connectionUI.showConnections()
            .then(function(connectionCreds): void {
                if (connectionCreds) {
                    // close active connection
                    self.onDisconnect().then(function(): void {
                        // connect to the server/database
                        self.connect(connectionCreds)
                        .then(function(): void {
                            resolve(true);
                        });
                    });
                }
            });
        });
    }

    // create a new connection with the connectionCreds provided
    public connect(connectionCreds: Interfaces.IConnectionCredentials): Promise<any> {
        const self = this;
        return new Promise<any>((resolve, reject) => {
            let extensionTimer = new Utils.Timer();

            // package connection details for request message
            let connectionDetails = new ConnectionDetails();
            connectionDetails.userName = connectionCreds.user;
            connectionDetails.password = connectionCreds.password;
            connectionDetails.serverName = connectionCreds.server;
            connectionDetails.databaseName = connectionCreds.database;

            let connectParams = new ConnectParams();
            connectParams.ownerUri = 'vscode-mssql'; // TODO: this should vary per-file
            connectParams.connection = connectionDetails;

            let serviceTimer = new Utils.Timer();

            // send connection request message to service host
            let client: LanguageClient = SqlToolsServerClient.getInstance().getClient();
            client.sendRequest(ConnectionRequest.type, connectParams).then((result) => {
                // handle connection complete callback
                console.log(result);
            });

            // legacy tedious connection until we fully move to service host
            const connection = new mssql.Connection(connectionCreds);
            self.statusView.connecting(connectionCreds);

            connection.connect()
            .then(function(): void {
                serviceTimer.end();

                self._connectionCreds = connectionCreds;
                self._connection = connection;
                self.statusView.connectSuccess(connectionCreds);

                extensionTimer.end();

                Telemetry.sendTelemetryEvent(self._context, 'DatabaseConnected', {}, {
                    extensionConnectionTime: extensionTimer.getDuration() - serviceTimer.getDuration(),
                    serviceConnectionTime: serviceTimer.getDuration()
                });

                resolve();
            })
            .catch(function(err): void {
                self.statusView.connectError(connectionCreds, err);
                Utils.showErrorMsg(Constants.msgError + err);
                reject(err);
            });
        });
    }

    public onCreateProfile(): Promise<boolean> {
        let self = this;
        return new Promise<any>((resolve, reject) => {
            self.connectionUI.createAndSaveProfile()
            .then(profile => {
                if (profile) {
                    resolve(true);
                } else {
                    resolve(false);
            }});
        });
    }

    public onRemoveProfile(): Promise<boolean> {
        return this.connectionUI.removeProfile();
    }
}