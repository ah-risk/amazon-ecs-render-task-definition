const run = require('.');
const core = require('@actions/core');
const tmp = require('tmp');
const fs = require('fs');

jest.mock('@actions/core');
jest.mock('tmp');
jest.mock('fs');
const mockDynamoGetItem = jest.fn();
jest.mock("aws-sdk", () => {
    return {
        DynamoDB: jest.fn(() => ({
            getItem: mockDynamoGetItem
        }))
    }
});

describe('Render task definition', () => {

    beforeEach(() => {
        jest.clearAllMocks();

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('web')                  // container-name
            .mockReturnValueOnce('nginx:latest')         // image
            .mockReturnValueOnce('meta-table')           // meta-table
            .mockReturnValueOnce('MetaID');              // meta-key

        process.env = Object.assign(process.env, { GITHUB_WORKSPACE: __dirname });
        process.env = Object.assign(process.env, { RUNNER_TEMP: '/home/runner/work/_temp' });
        process.env = Object.assign(process.env, { GITHUB_REF: "refs/heads/github-ref" });
        process.env = Object.assign(process.env, { GITHUB_REPOSITORY: "github/repo" });
        process.env = Object.assign(process.env, { GITHUB_SHA: "githubsha" });

        tmp.fileSync.mockReturnValue({
            name: 'new-task-def-file-name'
        });

        fs.existsSync.mockReturnValue(true);

        jest.mock('./task-definition.json', () => JSON.parse(JSON.stringify({
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: "web",
                    image: "some-other-image"
                },
                {
                    name: "sidecar",
                    image: "hello"
                }
            ],
            "taskRoleArn": "[meta:test-substitution]"
        })), { virtual: true });

        mockDynamoGetItem.mockImplementation((params) => {
            return {
                promise() {
                    const req = Object.keys(params.Key);
                    const item = {};
                    if (req.length > 0 && req[0] === "MetaID" && params.Key[req[0]].S === "test-substitution") {
                        item["MetaID"] = params.Key[req[0]];
                        item["value"] = {"S": "substituted-value"};
                    }
                    return Promise.resolve({
                        Item: item
                    });
                }
            }
        });
    });

    test('renders the task definition and creates a new task def file', async () => {
        await run();
        expect(tmp.fileSync).toHaveBeenNthCalledWith(1, {
            tmpdir: '/home/runner/work/_temp',
            prefix: 'task-definition-',
            postfix: '.json',
            keep: true,
            discardDescriptor: true
          });
        expect(fs.writeFileSync).toHaveBeenNthCalledWith(1, 'new-task-def-file-name',
            JSON.stringify({
                family: 'task-def-family',
                containerDefinitions: [
                    {
                        name: "web",
                        image: "nginx:latest",
                        environment: [
                            { "name": "GIT_SHA", "value": "githubsha" },
                            { "name": "GIT_REPOSITORY", "value": "github/repo" },
                            { "name": "GIT_BRANCH", "value": "github-ref" }
                        ]
                    },
                    {
                        name: "sidecar",
                        image: "hello"
                    }
                ],
                "taskRoleArn": "substituted-value",
                "tags": [
                    { "key": "GIT_REPOSITORY", "value": "github/repo" }
                ]
            }, null, 2)
        );
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition', 'new-task-def-file-name');
    });

    test('renders a task definition at an absolute path', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('/hello/task-definition.json') // task-definition
            .mockReturnValueOnce('web')                  // container-name
            .mockReturnValueOnce('nginx:latest');         // image
        jest.mock('/hello/task-definition.json', () => ({
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: "web",
                    image: "some-other-image",
                    environment: []
                }
            ],
            tags: []
        }), { virtual: true });

        await run();

        expect(tmp.fileSync).toHaveBeenNthCalledWith(1, {
            tmpdir: '/home/runner/work/_temp',
            prefix: 'task-definition-',
            postfix: '.json',
            keep: true,
            discardDescriptor: true
          });
        expect(fs.writeFileSync).toHaveBeenNthCalledWith(1, 'new-task-def-file-name',
            JSON.stringify({
                family: 'task-def-family',
                containerDefinitions: [
                    {
                        name: "web",
                        image: "nginx:latest",
                        environment: [
                            { "name": "GIT_SHA", "value": "githubsha" },
                            { "name": "GIT_REPOSITORY", "value": "github/repo" },
                            { "name": "GIT_BRANCH", "value": "github-ref" }
                        ]
                    }
                ],
                "tags": [
                    { "key": "GIT_REPOSITORY", "value": "github/repo" }
                ]
            }, null, 2)
        );
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition', 'new-task-def-file-name');
    });

    test('error returned for missing task definition file', async () => {
        fs.existsSync.mockReturnValue(false);
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('does-not-exist-task-definition.json')
            .mockReturnValueOnce('web')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(core.setFailed).toBeCalledWith('Task definition file does not exist: does-not-exist-task-definition.json');
    });

    test('error returned for non-JSON task definition contents', async () => {
        jest.mock('./non-json-task-definition.json', () => ("hello"), { virtual: true });

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('non-json-task-definition.json')
            .mockReturnValueOnce('web')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(core.setFailed).toBeCalledWith('Invalid task definition format: containerDefinitions section is not present or is not an array');
    });

    test('error returned for malformed task definition with non-array container definition section', async () => {
        jest.mock('./malformed-task-definition.json', () => ({
            family: 'task-def-family',
            containerDefinitions: {}
        }), { virtual: true });

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('malformed-task-definition.json')
            .mockReturnValueOnce('web')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(core.setFailed).toBeCalledWith('Invalid task definition format: containerDefinitions section is not present or is not an array');
    });

    test('error returned for task definition without matching container name', async () => {
        jest.mock('./missing-container-task-definition.json', () => ({
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: "main",
                    image: "some-other-image"
                }
            ]
        }), { virtual: true });

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('missing-container-task-definition.json')
            .mockReturnValueOnce('web')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(core.setFailed).toBeCalledWith('Invalid task definition: Could not find container definition with matching name');
    });

    test('error returned for task definition with meta substitution without specified meta-table', async () => {
        jest.mock('./task-definition-no-table.json', () => ({
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: "main",
                    image: "some-other-image"
                }
            ],
            taskRoleArn: "[meta:substitution-missing]"
        }), { virtual: true });

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition-no-table.json')
            .mockReturnValueOnce('main')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(core.setFailed).toBeCalledWith('Encountered meta substitution but table was not specified');
    });

    test('existing environment and tag values are not overwritten', async () => {
        jest.mock('./task-definition-no-overwrite.json', () => ({
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: "main",
                    image: "nginx:latest",
                    environment: [
                        { "name": "GIT_SHA", "value": "testsha" },
                        { "name": "GIT_REPOSITORY", "value": "test/repo" },
                        { "name": "GIT_BRANCH", "value": "test-ref" }
                    ]
                }
            ],
            "tags": [
                { "key": "GIT_REPOSITORY", "value": "test/repo" }
            ]
        }), { virtual: true });
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition-no-overwrite.json')
            .mockReturnValueOnce('main')
            .mockReturnValueOnce('nginx:latest');

        await run();

        expect(tmp.fileSync).toHaveBeenNthCalledWith(1, {
            tmpdir: '/home/runner/work/_temp',
            prefix: 'task-definition-',
            postfix: '.json',
            keep: true,
            discardDescriptor: true
          });
        expect(fs.writeFileSync).toHaveBeenNthCalledWith(1, 'new-task-def-file-name',
            JSON.stringify({
                family: 'task-def-family',
                containerDefinitions: [
                    {
                        name: "main",
                        image: "nginx:latest",
                        environment: [
                            { "name": "GIT_SHA", "value": "testsha" },
                            { "name": "GIT_REPOSITORY", "value": "test/repo" },
                            { "name": "GIT_BRANCH", "value": "test-ref" }
                        ]
                    }
                ],
                "tags": [
                    { "key": "GIT_REPOSITORY", "value": "test/repo" }
                ]
            }, null, 2)
        );
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition', 'new-task-def-file-name');
    });
});
