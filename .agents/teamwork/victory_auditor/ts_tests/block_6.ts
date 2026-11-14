export type ElementMountState = 'MOUNTED_VISIBLE' | 'MOUNTED_OFFSCREEN' | 'UNMOUNTED_VIRTUALIZED';

     export async function checkElementMountState(
       target: ExecutionTarget,
       entityContainerSelector?: string
     ): Promise<ElementMountState> {
       if (!entityContainerSelector) return 'UNMOUNTED_VIRTUALIZED';
       const container = await target.querySelector(entityContainerSelector);
       if (!container || !(await container.isConnected())) {
         return 'UNMOUNTED_VIRTUALIZED';
       }
       const inViewport = await target.isInViewport(container);
       return inViewport ? 'MOUNTED_VISIBLE' : 'MOUNTED_OFFSCREEN';
     }