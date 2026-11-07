import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@kaikansen/contracts';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'Service is up.' })
  health(): HealthResponse {
    return { status: 'ok', service: 'kaikansen-api' };
  }
}
