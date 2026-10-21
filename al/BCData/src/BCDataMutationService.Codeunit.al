codeunit 50107 "BCD Mutation Service"
{
    // Separate service/object execution permission. No business-table elevation.
    procedure Prepare(inputJson: Text): Text
    var
        Request: JsonObject;
        Result: Text;
    begin
        ParseEnvelope(inputJson, 'requestId', Request);
        CheckCompany();
        Coordinator.PurgeExpiredOwned();
        Result := Coordinator.Prepare(ReadGuid(Request, 'requestId'));
        exit(WithCompany(Result));
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(inputJson: Text): Text
    var
        Request: JsonObject;
        Token: JsonToken;
        Payload: Text;
    begin
        ParseEnvelope(inputJson, 'requestId,epoch,request', Request);
        CheckCompany();
        Request.Get('request', Token);
        if not Token.IsObject() then
            Error('BCD_INVALID_INPUT: request must be a mutation object.');
        Token.WriteTo(Payload);
        exit(WithCompany(Coordinator.Execute(ReadGuid(Request, 'requestId'), ReadGuid(Request, 'epoch'), Payload)));
    end;

    procedure Close(inputJson: Text): Text
    var
        Request: JsonObject;
    begin
        ParseEnvelope(inputJson, 'requestId,epoch', Request);
        CheckCompany();
        Coordinator.Close(ReadGuid(Request, 'requestId'), ReadGuid(Request, 'epoch'));
        exit(WithCompany('{"closed":true}'));
    end;

    local procedure ParseEnvelope(Input: Text; Properties: Text; var Request: JsonObject)
    var
        Names: List of [Text];
        Name: Text;
    begin
        if (StrLen(Input) > 65536) or not Request.ReadFrom(Input) then
            Error('BCD_INVALID_INPUT: bounded JSON envelope required.');
        Names := Properties.Split(',');
        if Request.Keys().Count() <> Names.Count() then
            Error('BCD_INVALID_INPUT: unexpected or missing mutation envelope properties.');
        foreach Name in Request.Keys() do
            if not Names.Contains(Name) then
                Error('BCD_INVALID_INPUT: unexpected mutation envelope property.');
    end;

    local procedure ReadGuid(Request: JsonObject; Name: Text): Guid
    var
        Decoder: Codeunit "BCD Field Input";
        Token: JsonToken;
        Value: Guid;
    begin
        Request.Get(Name, Token);
        if not Evaluate(Value, Decoder.RequireString(Token)) or IsNullGuid(Value) then
            Error('BCD_INVALID_INPUT: nonzero request ID/epoch GUID required.');
        exit(Value);
    end;

    local procedure CheckCompany()
    begin
        if CompanyName() = '' then
            Error('BCD_INVALID_INPUT: explicit company context required.');
    end;

    local procedure WithCompany(Result: Text): Text
    var
        Company: Record Company;
        Response: JsonObject;
    begin
        Company.Get(CompanyName());
        Response.ReadFrom(Result);
        Response.Add('companyId', LowerCase(Format(Company.Id, 0, 4)));
        Response.WriteTo(Result);
        exit(Result);
    end;

    var
        Coordinator: Codeunit "BCD Mutation Coordinator";
}
