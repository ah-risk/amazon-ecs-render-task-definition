const path = require('path');
const core = require('@actions/core');
const tmp = require('tmp');
const fs = require('fs');
const aws = require('aws-sdk');

async function traverse(o,func) {
  for (var i in o) {
      await func.apply(this, [i, o[i], o]);
      if (o[i] !== null && typeof(o[i]) == "object") {
          await traverse(o[i], func);
      }
  }
}

async function run() {
  try {
    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const containerName = core.getInput('container-name', { required: true });
    const imageURI = core.getInput('image', { required: true });
    const metaTable = core.getInput('meta-table', { required: false });
    const metaKey = core.getInput('meta-key', { required: false })
    const dynamo = metaTable ? new aws.DynamoDB() : undefined;

    // Parse the task definition
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    if (!fs.existsSync(taskDefPath)) {
      throw new Error(`Task definition file does not exist: ${taskDefinitionFile}`);
    }
    const taskDefContents = require(taskDefPath);

    // Insert the image URI
    if (!Array.isArray(taskDefContents.containerDefinitions)) {
      throw new Error('Invalid task definition format: containerDefinitions section is not present or is not an array');
    }
    const containerDef = taskDefContents.containerDefinitions.find(function(element) {
      return element.name == containerName;
    });
    if (!containerDef) {
      throw new Error('Invalid task definition: Could not find container definition with matching name');
    }
    containerDef.image = imageURI;

    // Prepare environment
    if (!Array.isArray(containerDef.environment)) {
      containerDef.environment = [];
    }
    const gitRepo = process.env.GITHUB_REPOSITORY;
    const gitSha = process.env.GITHUB_SHA;
    const gitRef = process.env.GITHUB_REF;
    const gitBranch = gitRef != undefined ? gitRef.split("/").slice(-1)[0] : undefined;
    if(!containerDef.environment.some(x => x["name"] === "GIT_SHA")) {
      containerDef.environment.push({ "name": "GIT_SHA", "value": gitSha });
    }
    if(!containerDef.environment.some(x => x["name"] === "GIT_REPOSITORY")) {
      containerDef.environment.push({ "name": "GIT_REPOSITORY", "value": gitRepo });
    }
    if (gitBranch != undefined && !containerDef.environment.some(x => x["name"] === "GIT_BRANCH")) {
      containerDef.environment.push({ "name": "GIT_BRANCH", "value": gitBranch });
    }

    // Add GitHub values also as tags
    if (!Array.isArray(taskDefContents.tags)) {
      taskDefContents.tags = [];
    }
    if (!taskDefContents.tags.some(x => x["key"] === "GIT_REPOSITORY")) {
      taskDefContents.tags.push({ "key": "GIT_REPOSITORY", "value": gitRepo })
    }

    // Replace meta placeholders with actual retrieved values
    const metaTableKey = (metaKey ? metaKey : "metaID");
    await traverse(taskDefContents, async (k, v, ctx) => {
      if (typeof(v) != "string" || !v.startsWith("[meta:") || !v.endsWith("]")) return;
      if (dynamo == undefined) throw new Error("Encountered meta substitution but table was not specified");
      const metaKey = v.slice(6, -1);
      const params = {
        TableName: metaTable,
        Key: {}
      };
      params.Key[metaTableKey] = {"S": metaKey};
      const metaValue = await dynamo.getItem(params).promise();
      ctx[k] = metaValue.Item.value.S;
    });

    // Write out a new task definition file
    var updatedTaskDefFile = tmp.fileSync({
      tmpdir: process.env.RUNNER_TEMP,
      prefix: 'task-definition-',
      postfix: '.json',
      keep: true,
      discardDescriptor: true
    });
    const newTaskDefContents = JSON.stringify(taskDefContents, null, 2);
    fs.writeFileSync(updatedTaskDefFile.name, newTaskDefContents);
    core.setOutput('task-definition', updatedTaskDefFile.name);
  }
  catch (error) {
    core.setFailed(error.message);
    //throw error;
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
