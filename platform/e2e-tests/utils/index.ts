import * as agentUtils from './agent';
import * as authUtils from './auth';
import * as commonUtils from './common';
import * as trustedDataPolicyUtils from './trustedDataPolicy';
import * as toolInvocationPolicyUtils from './toolInvocationPolicy';

namespace utils {
  export const agent = agentUtils;
  export const common = commonUtils;
  export const trustedDataPolicy = trustedDataPolicyUtils;
  export const toolInvocationPolicy = toolInvocationPolicyUtils;
}

export default utils;
