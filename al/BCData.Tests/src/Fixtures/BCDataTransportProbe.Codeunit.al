codeunit 50210 "BCD Transport Probe"
{
    // E01 fixture only. This is not the production data-access contract.
    procedure Echo(inputJson: Text): Text
    var
        Payload: JsonToken;
        Response: JsonObject;
        Output: Text;
    begin
        if not Payload.ReadFrom(inputJson) then
            Error('BCD_E01_INVALID_JSON');
        Response.Add('experiment', 'E01');
        Response.Add('fixtureVersion', '1');
        Response.Add('company', CompanyName());
        Response.Add('inputJson', inputJson);
        Response.Add('payload', Payload);
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Fail(inputJson: Text): Text
    begin
        // Do not include caller input in the deliberate error.
        Error('BCD_E01_DELIBERATE_ERROR');
    end;
}
