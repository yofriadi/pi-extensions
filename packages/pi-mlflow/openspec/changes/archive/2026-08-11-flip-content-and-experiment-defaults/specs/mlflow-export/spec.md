## MODIFIED Requirements

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
