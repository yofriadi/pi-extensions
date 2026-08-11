# mlflow-export Specification

## Purpose

TBD - created by archiving change add-pi-mlflow-tracing-extension.
Update Purpose after archive.

## Requirements

### Requirement: Extension connects to a user-managed local MLflow Tracking Server

The system SHALL connect to an MLflow Tracking Server at a configured tracking URI.
The system SHALL NOT start, stop, install, or otherwise manage the lifecycle of the `mlflow server` process.

#### Scenario: Extension connects to a running local server

- **WHEN** the extension loads and a configured MLflow Tracking Server is reachable at the configured tracking URI
- **THEN** the extension initializes the MLflow tracing SDK against that server and begins tracing

#### Scenario: Extension does not attempt to launch a server

- **WHEN** no MLflow server process is running
- **THEN** the extension does not attempt to spawn, install, or start one

### Requirement: Experiment is resolved or created automatically

On load, the system SHALL resolve the configured experiment name to a numeric experiment ID by querying the MLflow Tracking Server, creating the experiment if it does not already exist, so the user is not required to manually create an experiment or copy an experiment ID from the MLflow UI.

#### Scenario: Experiment already exists

- **WHEN** the configured experiment name matches an existing MLflow experiment
- **THEN** the extension resolves that experiment's ID and uses it to initialize tracing, without creating a duplicate experiment

#### Scenario: Experiment does not exist yet

- **WHEN** the configured experiment name does not match any existing MLflow experiment
- **THEN** the extension creates a new experiment with that name and uses the resulting ID to initialize tracing

#### Scenario: Experiment ID is cached for the process lifetime

- **WHEN** the experiment has been resolved once during extension load
- **THEN** the extension does not re-resolve the experiment via the MLflow REST API again during that same pi process's lifetime

### Requirement: Unreachable tracking server disables tracing silently

If the configured MLflow Tracking Server is unreachable at extension load time (experiment resolution or SDK initialization fails), the system SHALL disable tracing for the remainder of that pi process, log the failure once, and SHALL NOT retry the connection or interrupt the user with an interactive warning.

#### Scenario: Server unreachable at startup

- **WHEN** the extension attempts to resolve the experiment or initialize the tracing SDK and the tracking server is unreachable
- **THEN** tracing is disabled for the rest of that pi process, one log line records the failure, and no further connection attempts are made during that process

#### Scenario: No interactive interruption on failure

- **WHEN** the tracking server is unreachable at startup
- **THEN** the user is not shown an interactive dialog, prompt, or blocking warning about the failure during normal use of pi

### Requirement: Configuration is read from a local file

The system SHALL read its connection configuration (tracking URI, experiment name, content-capture mode) from a local configuration file, with a documented default tracking URI pointing at a typical local MLflow server and a default experiment name derived from the project working directory.

#### Scenario: Default tracking URI is used when unspecified

- **WHEN** the configuration file does not specify a tracking URI
- **THEN** the extension defaults to a local MLflow server address (`http://localhost:5055`)

#### Scenario: Configured tracking URI overrides the default

- **WHEN** the configuration file specifies a tracking URI
- **THEN** the extension connects to that URI instead of the default

#### Scenario: Default experiment name is the project directory name

- **WHEN** the configuration file does not specify an experiment name (including when no configuration file exists)
- **THEN** the extension uses the basename of the pi process's working directory as the experiment name

#### Scenario: Filesystem-root working directory falls back to a fixed default

- **WHEN** the configuration file does not specify an experiment name and the working directory's basename is empty (filesystem root)
- **THEN** the extension uses `pi` as the experiment name

#### Scenario: Configured experiment name overrides the directory default

- **WHEN** the configuration file specifies an experiment name
- **THEN** the extension uses that name instead of the working-directory basename

#### Scenario: Explicit empty experiment name is rejected

- **WHEN** the configuration file specifies an empty-string experiment name
- **THEN** configuration loading fails and the extension does not initialize tracing with that name (absent is not the same as empty)

### Requirement: Tracking URI must not embed credentials

The system SHALL reject a configured tracking URI that embeds userinfo credentials.
Authentication SHALL use environment variables only (`MLFLOW_TRACKING_USERNAME`/`MLFLOW_TRACKING_PASSWORD` or `MLFLOW_TRACKING_TOKEN`), so credentials cannot leak via request or timeout errors that include the full URL.

#### Scenario: trackingUri with userinfo is rejected

- **WHEN** the configuration file specifies a tracking URI containing credentials (for example `http://user:pass@host:5000`)
- **THEN** configuration loading fails and the extension does not initialize tracing with that URI

#### Scenario: Environment-variable authentication is supported

- **WHEN** the tracking server requires authentication and credentials are provided via the MLflow tracking env vars
- **THEN** the extension can connect without placing credentials in `trackingUri`
